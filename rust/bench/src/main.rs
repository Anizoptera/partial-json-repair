//! Does a state-of-the-art Rust JSON parser belong in this package's architecture?
//!
//! The published JSON benchmarks all measure three large files (twitter 630 KB, citm 1.7 MB,
//! canada 2.2 MB), so they answer "how fast is a megabyte" and nothing else. This package's inputs
//! are model output and damaged fragments — the recorded corpus has a MEDIAN of 25 bytes and 97.7%
//! of it under 1 KB — and a SIMD parser's whole mechanism is amortising a per-64-byte-block cost
//! over length. So the question a size ladder answers, and a fixed-corpus benchmark cannot, is
//! WHERE the crossover sits: above it a SIMD dependency buys speed, below it it costs speed.
//!
//! The ladder is the instrument; the corpus distribution is not used as the workload, because a
//! test corpus is evidence about the tests rather than about consumer traffic.
//!
//! simd-json is timed WITH the copy into a mutable padded buffer, because it mutates its input in
//! place and a consumer holding a `&[u8]` has no way to avoid paying it. Leaving it out would
//! measure a call a real caller cannot make.

use std::hint::black_box;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use partial_json_repair::{Parser, Scanner};

static OPTIONS: LazyLock<Parser> = LazyLock::new(Parser::default);

/// One thing being timed. A `&[u8]` in and a discarded tree out, so every subject does the same job.
struct Subject {
    name: &'static str,
    run: fn(&[u8]) -> usize,
}

/// Each subject returns 1 on success and 0 on refusal, black-boxed by the caller so the optimiser
/// cannot delete the parse. The tree is dropped inside the timed region on purpose: freeing what a
/// parser allocated is a cost its consumer really pays, and excluding it would flatter whichever
/// subject allocates most.
fn ours(input: &[u8]) -> usize {
    usize::from(Scanner::new(input, &OPTIONS).parse().is_ok())
}

fn serde(input: &[u8]) -> usize {
    usize::from(serde_json::from_slice::<serde_json::Value>(input).is_ok())
}

fn jiter(input: &[u8]) -> usize {
    usize::from(jiter::JsonValue::parse(input, false).is_ok())
}

fn json5(input: &[u8]) -> usize {
    usize::from(serde_json5::from_slice::<serde_json::Value>(input).is_ok())
}

fn struson(input: &[u8]) -> usize {
    use struson::reader::simple::{SimpleJsonReader, ValueReader as _};
    usize::from(
        SimpleJsonReader::new(input)
            .read_deserialize::<serde_json::Value>()
            .is_ok(),
    )
}

fn tinyjson(input: &[u8]) -> usize {
    usize::from(
        std::str::from_utf8(input)
            .ok()
            .and_then(|text| text.parse::<tinyjson::JsonValue>().ok())
            .is_some(),
    )
}

fn simd_borrowed(input: &[u8]) -> usize {
    // simd-json mutates the buffer and requires trailing padding, so the copy is part of the call:
    // a consumer holding a `&[u8]` has no way to avoid it.
    let mut buf = input.to_vec();
    usize::from(simd_json::to_borrowed_value(&mut buf).is_ok())
}

fn sonic(input: &[u8]) -> usize {
    usize::from(sonic_rs::from_slice::<sonic_rs::Value>(input).is_ok())
}

const SUBJECTS: &[Subject] = &[
    Subject {
        name: "ours",
        run: ours,
    },
    Subject {
        name: "serde_json",
        run: serde,
    },
    Subject {
        name: "jiter",
        run: jiter,
    },
    Subject {
        name: "json5",
        run: json5,
    },
    Subject {
        name: "struson",
        run: struson,
    },
    Subject {
        name: "tinyjson",
        run: tinyjson,
    },
    Subject {
        name: "simd-json",
        run: simd_borrowed,
    },
    Subject {
        name: "sonic-rs",
        run: sonic,
    },
];

/// Deterministic pseudo-random source: the documents must be byte-identical across processes, or
/// the between-process spread would measure the generator instead of the parsers.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // SplitMix64. Chosen for being a few instructions and having no state beyond a word.
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Builds a document of roughly `target` bytes with the shape real JSON has: objects of a handful
/// of keys, nested a few levels, mixing strings, numbers, booleans and arrays.
///
/// Shape matters more than size alone — a document of one huge string and a document of ten
/// thousand small members are different work for every parser here, and a generator that emitted
/// either extreme would report a property of itself.
fn realistic(target: usize, seed: u64) -> String {
    let mut rng = Rng(seed);
    let mut out = String::with_capacity(target + 64);
    out.push('[');
    let mut first = true;
    while out.len() < target {
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(r#"{"id":"#);
        out.push_str(&rng.below(1_000_000).to_string());
        out.push_str(r#","name":""#);
        for _ in 0..rng.below(12) + 4 {
            out.push((b'a' + rng.below(26) as u8) as char);
        }
        out.push_str(r#"","score":"#);
        out.push_str(&format!("{}.{}", rng.below(100), rng.below(1000)));
        out.push_str(r#","active":"#);
        out.push_str(if rng.next() % 2 == 0 { "true" } else { "false" });
        out.push_str(r#","tags":["#);
        for t in 0..rng.below(4) {
            if t > 0 {
                out.push(',');
            }
            out.push_str(r#""t""#);
        }
        out.push_str(r#"],"meta":{"v":null,"n":"#);
        out.push_str(&rng.below(9999).to_string());
        out.push_str("}}");
    }
    out.push(']');
    out
}

/// A single object of `keys` members. Isolates duplicate-key handling, which is where a vector of
/// pairs with a linear scan per insertion turns quadratic while a map does not.
fn wide_object(keys: usize) -> String {
    let mut out = String::from("{");
    for k in 0..keys {
        if k > 0 {
            out.push(',');
        }
        out.push_str(&format!("\"k{k}\":{k}"));
    }
    out.push('}');
    out
}

/// Timing for one subject on one input.
///
/// Minimum WITHIN the process, never a mean: everything else on the machine can only ADD time, so
/// the minimum converges on what the code costs uncontended while an average tracks how busy the
/// machine was. The error bar comes from separate PROCESSES, which is the caller's job — batches
/// inside one process share a JIT-free but still shared heap layout, allocator state and CPU
/// frequency, so their agreement measures the process rather than reproducibility.
///
/// Stops on convergence rather than a fixed batch count: a fixed count gives a fast subject no
/// chance to find an uncontended run and biases its first moment upward. The wall-clock budget is
/// what bounds the patience.
///
/// The sequence and constants transliterate `estimate` in `bench/estimator.ts`, so a Rust cell and a
/// JavaScript cell in `baseline.json` come from the same estimator; `bench/MEASUREMENT.md` owns the
/// reasons, and the two change together.
fn measure(subject: &Subject, input: &[u8]) -> f64 {
    const MIN_BATCH_MS: f64 = 0.5;
    const PATIENCE: u32 = 25;
    const MAX_BATCHES: u32 = 200;
    const BUDGET: Duration = Duration::from_millis(200);
    const WARMUP: usize = 100;
    let batch = |k: usize| -> f64 {
        let start = Instant::now();
        for _ in 0..k {
            black_box((subject.run)(black_box(input)));
        }
        start.elapsed().as_secs_f64() * 1e3
    };

    // Calibrate a batch long enough that the clock's own resolution is not part of the reading. A
    // zero reading is under one clock step, so it doubles rather than aiming from an invented value.
    let mut k = 1usize;
    loop {
        let ms = batch(k);
        if ms >= MIN_BATCH_MS {
            break;
        }
        let aim = (k as f64 * MIN_BATCH_MS / ms.max(0.01)).ceil() as usize;
        k = if ms == 0.0 { k * 2 } else { (k * 2).max(aim) };
    }

    // Floor the warm-up in INVOCATIONS, not milliseconds: a slow subject satisfies a duration-based
    // calibration on its first call and would be timed cold for ever. Half the budget at most, so a
    // subject slow enough to spend it warming still leaves something to measure.
    let started = Instant::now();
    let mut warmed = 0;
    while warmed < k.max(WARMUP) && started.elapsed() < BUDGET / 2 {
        black_box((subject.run)(black_box(input)));
        warmed += 1;
    }

    let mut best = f64::INFINITY;
    let mut unbeaten = 0;
    for _ in 0..MAX_BATCHES {
        let ms = batch(k);
        if ms < best {
            best = ms;
            unbeaten = 0;
        } else {
            unbeaten += 1;
            if unbeaten >= PATIENCE {
                break;
            }
        }
        if started.elapsed() > BUDGET {
            break;
        }
    }
    best * 1e6 / k as f64
}

/// The ladder, as one list, so the timing run and the dump cannot drift apart.
fn ladder_cases() -> Vec<(String, String)> {
    let mut cases: Vec<(String, String)> = Vec::new();
    // Roughly quarter-decade steps, from below one vector register to past the sizes the published
    // JSON benchmarks use, so a crossover cannot fall outside the range.
    for target in [
        16usize, 64, 256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576,
    ] {
        cases.push((format!("ladder/{target}"), realistic(target, 0x5eed)));
    }
    for keys in [8usize, 64, 512, 4_096] {
        cases.push((format!("wide/{keys}"), wide_object(keys)));
    }
    cases
}

/// The libraries the baseline emission reports, by the name the published table uses.
const LIBRARIES: &[(&str, DigestOf, fn(&[u8]) -> usize)] = &[
    ("partial-json-repair", digest_ours, ours),
    ("serde_json", digest_serde, serde),
    ("jiter", digest_jiter, jiter),
    ("json5", digest_json5, json5),
    ("struson", digest_struson, struson),
    ("tinyjson", digest_tinyjson, tinyjson),
    ("simd-json", digest_simd, simd_borrowed),
    ("sonic-rs", digest_sonic, sonic),
];

/// Emits this runtime's rates in the wire format `bench/prior-art/baseline.ts` reads.
///
/// Rust joins the SAME matrix as every JavaScript runtime rather than getting a report of its own.
/// A second comparison system would need a second estimator, a second rounding rule and a second set
/// of documents, and the two would drift with nothing to reveal it — which is the reason
/// `baseline.ts` accepts any command that prints this shape.
///
/// The documents and their expected values arrive on stdin as `{"cases": …, "wants": …}`, built by
/// `baseline.ts` from `EMIT=cases` and `EMIT=wants` of `compare.ts`, so the five cases and their
/// answers have one owner and cannot diverge between languages.
///
/// **A rate is reported only for a library whose digest matches the expected value's.** The expected
/// value of the damaged case is what the TypeScript package recovers, so this crate's own answer is
/// judged rather than trusted: taking the reference from the parser under test would let it agree
/// with itself whatever it returned.
fn baseline() {
    use std::io::Read as _;
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("case documents on stdin");
    let mut received: serde_json::Value = serde_json::from_str(&input)
        .expect("stdin is {cases: {case: document}, wants: {case: value}}");
    let cases: std::collections::BTreeMap<String, String> =
        serde_json::from_value(received["cases"].take()).expect("cases is {case: document}");
    let wants: std::collections::BTreeMap<String, serde_json::Value> =
        serde_json::from_value(received["wants"].take()).expect("wants is {case: value}");

    let mut rates: std::collections::BTreeMap<&str, std::collections::BTreeMap<&str, f64>> =
        LIBRARIES
            .iter()
            .map(|(n, _, _)| (*n, Default::default()))
            .collect();

    for (case, text) in &cases {
        let bytes = text.as_bytes();
        let want = wants.get(case).expect("every case has an expected value");
        let mut oracle = Digest::default();
        walk::serde(want, &mut oracle);
        for (name, digest, run) in LIBRARIES {
            if digest(bytes) != Some(Digest { ..oracle }) {
                continue;
            }
            let ns = measure(&Subject { name, run: *run }, bytes);
            let megabytes = bytes.len() as f64 / 1024.0 / 1024.0;
            rates.entry(name).or_default().insert(
                // Leaked so the map can borrow it for the life of the process; the set is the five
                // fixed cases, so this is a handful of small allocations, not a growing leak.
                Box::leak(case.clone().into_boxed_str()),
                megabytes / (ns / 1e9),
            );
        }
    }

    println!(
        r#"{{"runtime":"rust {}","rates":{}}}"#,
        env!("BUILT_BY_RUSTC"),
        serde_json::to_string(&rates).expect("rates serialise")
    );
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let dumps_ladder = mode
        .strip_prefix("dump:")
        .is_some_and(|directory| !directory.is_empty());
    if !matches!(mode.as_str(), "" | "baseline" | "healing" | "conformance" | "walked")
        && !dumps_ladder
    {
        eprintln!("unknown benchmark mode: {mode}");
        std::process::exit(2);
    }
    if mode == "baseline" {
        baseline();
        return;
    }
    if mode == "healing" {
        healing();
        return;
    }
    if mode == "conformance" {
        conformance();
        return;
    }
    // Writing the ladder out is what lets a parser in another language be measured on the SAME
    // bytes. A second generator in each language would compare the generators as much as the
    // parsers, and the difference would be invisible because both would produce plausible JSON.
    if let Some(dir) = mode.strip_prefix("dump:") {
        std::fs::create_dir_all(dir).expect("dump directory");
        for (name, doc) in ladder_cases() {
            let path = format!("{dir}/{}.json", name.replace('/', "-"));
            std::fs::write(&path, &doc).expect("write case");
        }
        println!("wrote ladder to {dir}");
        return;
    }
    let subjects: &[Subject] = if mode == "walked" { WALKED } else { SUBJECTS };
    let mut cases: Vec<(String, String)> = Vec::new();
    // The ladder. Roughly quarter-decade steps, from below one vector register to well past the
    // sizes the published JSON benchmarks use, so the crossover cannot fall outside it.
    for target in [
        16usize, 64, 256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576,
    ] {
        cases.push((format!("ladder/{target}"), realistic(target, 0x5eed)));
    }
    for keys in [8usize, 64, 512, 4_096] {
        cases.push((format!("wide/{keys}"), wide_object(keys)));
    }

    for (name, doc) in &cases {
        let bytes = doc.as_bytes();
        for subject in subjects {
            // A subject that cannot parse the input at all must not be reported as fast.
            let ok = (subject.run)(bytes) != 0;
            let ns = measure(subject, bytes);
            println!(
                r#"{{"case":"{}","bytes":{},"subject":"{}","ns":{:.3},"ok":{}}}"#,
                name,
                bytes.len(),
                subject.name,
                ns,
                ok
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Controls. A parse benchmark that never reads the tree cannot tell a full materialisation from a
// lazy one, and a speed table cannot tell a faithful answer from a fast wrong one. Both below.
// ---------------------------------------------------------------------------------------------

/// A structural summary of a parsed tree, comparable across parsers that share no types.
///
/// Two jobs, one mechanism. It is the CORRECTNESS GATE for the baseline emission — a rate is
/// reported only for a library whose digest matches the oracle's, so a parser that stops early
/// cannot appear as throughput, which is the failure `bench/prior-art/compare.ts` records having
/// measured (a library "read" a 400-row document at 19 600 MB/s by returning after the first value).
/// It is also the traversal control for the speed table: a lazily-parsed document costs nothing to
/// produce and everything to read, so a subject whose advantage vanishes under a full walk was never
/// doing the same job as the others.
///
/// A digest rather than full value equality on purpose. Comparing values across four crates needs
/// four canonicalisers, whose own bugs would be indistinguishable from parser differences; the
/// failure this gate exists to catch moves the node count by orders of magnitude. The limit is
/// stated rather than hidden: it would not notice two parsers disagreeing about one character
/// inside one string, which is what the `conformance` mode exists to show.
#[derive(Debug, Default, PartialEq)]
struct Digest {
    nodes: u64,
    /// Total bytes of every string, key or value. Catches a truncated or skipped string.
    text: u64,
    /// Sum of every number. Catches a wrong numeric reading that leaves the shape intact.
    sum: f64,
}

impl Digest {
    fn node(&mut self) {
        self.nodes += 1;
    }
}

mod walk {
    use partial_json_repair::{JsonString, Number, Value as Ours};
    use sonic_rs::{JsonContainerTrait as _, JsonValueTrait as _};

    use crate::Digest;

    pub fn ours(v: &Ours<'_>, d: &mut Digest) {
        d.node();
        match v {
            Ours::Array(items) => items.iter().for_each(|i| ours(i, d)),
            Ours::Object(o) => {
                for (k, value) in o.entries() {
                    string(k, d);
                    ours(value, d);
                }
            }
            Ours::String(s) => string(s, d),
            Ours::Number(Number::Double(n)) => d.sum += n,
            // An exact number is kept as digits precisely because a double would round it; adding
            // its rounded value back is only for the digest, never for a result.
            Ours::Number(Number::Exact(text)) => d.sum += text.parse::<f64>().unwrap_or(0.0),
            Ours::Null | Ours::Undefined | Ours::Bool(_) => {}
        }
    }

    fn string(s: &JsonString<'_>, d: &mut Digest) {
        d.text += match s {
            JsonString::Text(t) => t.len() as u64,
            JsonString::Units(u) => u.len() as u64,
        };
    }

    pub fn serde(v: &serde_json::Value, d: &mut Digest) {
        d.node();
        match v {
            serde_json::Value::Array(a) => a.iter().for_each(|i| serde(i, d)),
            serde_json::Value::Object(o) => {
                for (k, value) in o {
                    d.text += k.len() as u64;
                    serde(value, d);
                }
            }
            serde_json::Value::String(s) => d.text += s.len() as u64,
            serde_json::Value::Number(n) => d.sum += n.as_f64().unwrap_or(0.0),
            serde_json::Value::Null | serde_json::Value::Bool(_) => {}
        }
    }

    pub fn jiter(v: &jiter::JsonValue<'_>, d: &mut Digest) {
        d.node();
        match v {
            jiter::JsonValue::Array(a) => a.iter().for_each(|i| jiter(i, d)),
            jiter::JsonValue::Object(o) => {
                for (key, value) in o.iter() {
                    d.text += key.len() as u64;
                    jiter(value, d);
                }
            }
            jiter::JsonValue::Str(s) => d.text += s.len() as u64,
            jiter::JsonValue::Int(n) => d.sum += *n as f64,
            jiter::JsonValue::BigInt(n) => d.sum += n.to_string().parse::<f64>().unwrap_or(0.0),
            jiter::JsonValue::Float(n) => d.sum += n,
            jiter::JsonValue::Null | jiter::JsonValue::Bool(_) => {}
        }
    }

    pub fn tinyjson(v: &tinyjson::JsonValue, d: &mut Digest) {
        d.node();
        match v {
            tinyjson::JsonValue::Array(a) => a.iter().for_each(|i| tinyjson(i, d)),
            tinyjson::JsonValue::Object(o) => {
                for (key, value) in o {
                    d.text += key.len() as u64;
                    tinyjson(value, d);
                }
            }
            tinyjson::JsonValue::String(s) => d.text += s.len() as u64,
            tinyjson::JsonValue::Number(n) => d.sum += n,
            tinyjson::JsonValue::Null | tinyjson::JsonValue::Boolean(_) => {}
        }
    }

    pub fn simd(v: &simd_json::BorrowedValue<'_>, d: &mut Digest) {
        use simd_json::prelude::*;
        d.node();
        if let Some(a) = v.as_array() {
            a.iter().for_each(|i| simd(i, d));
        } else if let Some(o) = v.as_object() {
            for (k, value) in o {
                d.text += k.len() as u64;
                simd(value, d);
            }
        } else if let Some(s) = v.as_str() {
            d.text += s.len() as u64;
        } else if let Some(n) = v.cast_f64() {
            d.sum += n;
        }
    }

    pub fn sonic(v: &sonic_rs::Value, d: &mut Digest) {
        d.node();
        if let Some(a) = v.as_array() {
            a.iter().for_each(|i| sonic(i, d));
        } else if let Some(o) = v.as_object() {
            for (k, value) in o {
                d.text += k.len() as u64;
                sonic(value, d);
            }
        } else if let Some(s) = v.as_str() {
            d.text += s.len() as u64;
        } else if let Some(n) = v.as_f64() {
            d.sum += n;
        }
    }
}

/// Parses with one library and returns its digest, or `None` when it refused the document.
type DigestOf = fn(&[u8]) -> Option<Digest>;

fn digest_ours(input: &[u8]) -> Option<Digest> {
    let value = Scanner::new(input, &OPTIONS).parse().ok()?;
    let mut d = Digest::default();
    walk::ours(&value, &mut d);
    Some(d)
}
fn digest_serde(input: &[u8]) -> Option<Digest> {
    let value = serde_json::from_slice::<serde_json::Value>(input).ok()?;
    let mut d = Digest::default();
    walk::serde(&value, &mut d);
    Some(d)
}
fn digest_jiter(input: &[u8]) -> Option<Digest> {
    let value = jiter::JsonValue::parse(input, false).ok()?;
    let mut d = Digest::default();
    walk::jiter(&value, &mut d);
    Some(d)
}
fn digest_json5(input: &[u8]) -> Option<Digest> {
    let value = serde_json5::from_slice::<serde_json::Value>(input).ok()?;
    let mut d = Digest::default();
    walk::serde(&value, &mut d);
    Some(d)
}
fn digest_struson(input: &[u8]) -> Option<Digest> {
    use struson::reader::simple::{SimpleJsonReader, ValueReader as _};
    let value = SimpleJsonReader::new(input)
        .read_deserialize::<serde_json::Value>()
        .ok()?;
    let mut d = Digest::default();
    walk::serde(&value, &mut d);
    Some(d)
}
fn digest_tinyjson(input: &[u8]) -> Option<Digest> {
    let value = std::str::from_utf8(input)
        .ok()?
        .parse::<tinyjson::JsonValue>()
        .ok()?;
    let mut d = Digest::default();
    walk::tinyjson(&value, &mut d);
    Some(d)
}
fn digest_simd(input: &[u8]) -> Option<Digest> {
    let mut buf = input.to_vec();
    let value = simd_json::to_borrowed_value(&mut buf).ok()?;
    let mut d = Digest::default();
    walk::simd(&value, &mut d);
    Some(d)
}
fn digest_sonic(input: &[u8]) -> Option<Digest> {
    let value = sonic_rs::from_slice::<sonic_rs::Value>(input).ok()?;
    let mut d = Digest::default();
    walk::sonic(&value, &mut d);
    Some(d)
}

fn ours_walked(input: &[u8]) -> usize {
    digest_ours(input).map_or(0, |d| d.nodes as usize + 1)
}
fn serde_walked(input: &[u8]) -> usize {
    digest_serde(input).map_or(0, |d| d.nodes as usize + 1)
}
fn jiter_walked(input: &[u8]) -> usize {
    digest_jiter(input).map_or(0, |d| d.nodes as usize + 1)
}
fn json5_walked(input: &[u8]) -> usize {
    digest_json5(input).map_or(0, |d| d.nodes as usize + 1)
}
fn struson_walked(input: &[u8]) -> usize {
    digest_struson(input).map_or(0, |d| d.nodes as usize + 1)
}
fn tinyjson_walked(input: &[u8]) -> usize {
    digest_tinyjson(input).map_or(0, |d| d.nodes as usize + 1)
}
fn simd_walked(input: &[u8]) -> usize {
    digest_simd(input).map_or(0, |d| d.nodes as usize + 1)
}
fn sonic_walked(input: &[u8]) -> usize {
    digest_sonic(input).map_or(0, |d| d.nodes as usize + 1)
}

const WALKED: &[Subject] = &[
    Subject {
        name: "ours",
        run: ours_walked,
    },
    Subject {
        name: "serde_json",
        run: serde_walked,
    },
    Subject {
        name: "jiter",
        run: jiter_walked,
    },
    Subject {
        name: "json5",
        run: json5_walked,
    },
    Subject {
        name: "struson",
        run: struson_walked,
    },
    Subject {
        name: "tinyjson",
        run: tinyjson_walked,
    },
    Subject {
        name: "simd-json",
        run: simd_walked,
    },
    Subject {
        name: "sonic-rs",
        run: sonic_walked,
    },
];

/// Inputs where this package's contract has an opinion that a conformant parser need not share.
///
/// Speed is the second gate, never the first: a parser that cannot represent the answer our corpus
/// records cannot serve any path here however fast it is. Each line prints what the rival actually
/// produced, so the comparison is against observed output rather than against its documentation.
fn conformance() {
    const CASES: &[(&str, &str)] = &[
        ("big-int", r#"{"n":12345678901234567890}"#),
        ("precise-frac", r#"{"n":0.1234567890123456789}"#),
        ("overflow", r#"{"n":1e400}"#),
        ("neg-zero", r#"{"n":-0}"#),
        ("dup-key", r#"{"a":1,"a":2}"#),
        ("int-like-order", r#"{"2":"b","1":"a","x":"c"}"#),
        ("lone-surrogate", r#"{"s":"\ud800"}"#),
        ("trailing-data", r#"{"a":1} trailing"#),
        ("truncated", r#"{"a":1,"b":"#),
        ("unclosed-string", r#"{"a":"hel"#),
        ("single-quotes", r#"{'a':1}"#),
        ("trailing-comma", r#"{"a":1,}"#),
    ];
    for (name, src) in CASES {
        let b = src.as_bytes();
        let ours = Scanner::new(b, &OPTIONS).parse().map_or_else(
            |e| format!("ERR {:?}", e.kind),
            |v| partial_json_repair::canonical_of(&v),
        );
        let serde = serde_json::from_slice::<serde_json::Value>(b)
            .map_or_else(|e| format!("ERR {e}"), |v| v.to_string());
        let mut buf = b.to_vec();
        let simd = simd_json::to_borrowed_value(&mut buf)
            .map_or_else(|e| format!("ERR {e}"), |v| v.to_string());
        let sonic = sonic_rs::from_slice::<sonic_rs::Value>(b)
            .map_or_else(|e| format!("ERR {e}"), |v| v.to_string());
        println!("--- {name}: {src}");
        println!("    ours       {ours}");
        println!("    serde_json {serde}");
        println!("    simd-json  {simd}");
        println!("    sonic-rs   {sonic}");
    }
}

/// What the two error-TOLERANT crates actually do with damaged input.
///
/// The speed table only ever compares conformant parsers, which all refuse damage outright. These
/// `jiter` is the live adoption candidate: it is the published Rust parser that claims to keep going
/// on truncated model output. Its documentation is not evidence about its recovery decisions, so
/// this prints what it produces for the shapes this package exists to survive.
///
/// `biome_json_parser` was the other candidate and is absent because it does not build: measured
/// 2026-09-06 on Rust 1.97.1, its newest published `biome_json_syntax` (0.5.7) implements the
/// `SyntaxKind` trait as it stood in `biome_rowan` 0.5.7, while `biome_parser` 0.5.8 calls the
/// `is_trivia` method 0.5.8 added, and no pinning of the three resolves. The crates are an internal
/// monorepo split published without an externally coherent version set.
fn healing() {
    const CASES: &[(&str, &str)] = &[
        ("truncated-object", r#"{"a":1,"b":"#),
        ("truncated-string", r#"{"a":"hel"#),
        ("truncated-array", r#"[1,2,{"x":"#),
        ("single-quotes", r#"{'a':1}"#),
        ("unquoted-key", r#"{a:1}"#),
        ("trailing-comma", r#"{"a":1,}"#),
        ("missing-comma", r#"{"a":1 "b":2}"#),
        ("comment", "{\"a\":1 // note\n}"),
        ("js-literal", r#"{"a":undefined}"#),
        ("hex-number", r#"{"a":0x1F}"#),
        ("fenced", "```json\n{\"a\":1}\n```"),
        (
            "prose-wrapped",
            r#"Here is the JSON: {"a":1} hope that helps"#,
        ),
        ("bare-member", r#"{"a":1, b}"#),
    ];
    for (name, src) in CASES {
        let ours = Scanner::new(src.as_bytes(), &OPTIONS).parse().map_or_else(
            |e| format!("ERR {:?}", e.kind),
            |v| partial_json_repair::canonical_of(&v),
        );
        let jiter = jiter::JsonValue::parse_with_config(
            src.as_bytes(),
            true,
            jiter::PartialMode::TrailingStrings,
        )
        .map_or_else(|e| format!("ERR {e}"), |v| format!("{v:?}"));
        println!("--- {name}: {src:?}");
        println!("    ours   {ours}");
        println!("    jiter  {jiter}");
    }
}
