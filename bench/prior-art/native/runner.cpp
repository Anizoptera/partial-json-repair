// SPDX-License-Identifier: Apache-2.0
//
// The C and C++ clean-parse subjects (yyjson, RapidJSON, simdjson) as one runner in the
// `baseline.ts` matrix. Built by `native.ts` from sources pinned by commit; never an npm binding,
// whose JS boundary would be measured instead of the parser.
//
// Reads `{case: document}` on stdin (the same bytes every runner gets), parses ONLY the `clean`
// case, and prints the `Emitted` wire format. Each library builds a full DOM, the job the other
// rows do. A rate is printed only for a library whose DOM serialises back to the exact input bytes:
// the clean document is compact `JSON.stringify` output holding integers, ASCII strings and
// booleans, so a correct parse round-trips byte for byte and a parser that stopped early cannot.
//
// The estimator transliterates `bench/estimator.ts`: calibrate a batch to 0.5 ms, warm up by at
// least 100 calls within half the 200 ms budget, then keep the minimum batch until 25 batches pass
// unbeaten. MEASUREMENT.md owns the reasons; change both together.

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <iterator>
#include <string>

#include "yyjson.h"
#include "rapidjson/document.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"
#include "simdjson.h"

namespace {

using clock_type = std::chrono::steady_clock;

double now_ms() {
  return std::chrono::duration<double, std::milli>(clock_type::now().time_since_epoch()).count();
}

// Read by every subject so the optimiser cannot discard a parse.
volatile size_t sink = 0;

template <typename F> double estimate_ns(F &&fn) {
  const double min_batch_ms = 0.5;
  const int patience = 25, max_batches = 200;
  const double budget_ms = 200;
  size_t k = 1;
  for (;;) {
    double t0 = now_ms();
    for (size_t i = 0; i < k; i++) fn();
    double ms = now_ms() - t0;
    if (ms >= min_batch_ms) break;
    // A zero reading is under one clock step: double rather than aim from an invented reading.
    size_t aim =
        ms == 0 ? 0 : static_cast<size_t>((k * min_batch_ms) / (ms > 0.01 ? ms : 0.01)) + 1;
    k = k * 2 > aim ? k * 2 : aim;
  }
  double start = now_ms();
  double warm_until = start + budget_ms / 2;
  size_t warm = k > 100 ? k : 100;
  for (size_t i = 0; i < warm && now_ms() < warm_until; i++) fn();
  double deadline = start + budget_ms;
  double best = 1e300;
  int unbeaten = 0;
  for (int b = 0; b < max_batches; b++) {
    double t0 = now_ms();
    for (size_t i = 0; i < k; i++) fn();
    double ms = now_ms() - t0;
    if (ms < best) {
      best = ms;
      unbeaten = 0;
    } else if (++unbeaten >= patience) break;
    if (now_ms() > deadline) break;
  }
  return best * 1e6 / static_cast<double>(k);
}

std::string yyjson_roundtrip(const std::string &text) {
  yyjson_doc *doc = yyjson_read(text.data(), text.size(), 0);
  if (doc == nullptr) return "";
  size_t len = 0;
  char *out = yyjson_write(doc, 0, &len);
  std::string s = out ? std::string(out, len) : "";
  std::free(out);
  yyjson_doc_free(doc);
  return s;
}

std::string rapidjson_roundtrip(const std::string &text) {
  rapidjson::Document d;
  d.Parse(text.data(), text.size());
  if (d.HasParseError()) return "";
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  d.Accept(writer);
  return std::string(buffer.GetString(), buffer.GetSize());
}

std::string simdjson_roundtrip(simdjson::dom::parser &parser, const simdjson::padded_string &ps) {
  simdjson::dom::element doc;
  if (parser.parse(ps).get(doc) != simdjson::SUCCESS) return "";
  return simdjson::minify(doc);
}

}  // namespace

int main() {
  std::string input((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
  yyjson_doc *cases = yyjson_read(input.data(), input.size(), 0);
  yyjson_val *clean_val = cases ? yyjson_obj_get(yyjson_doc_get_root(cases), "clean") : nullptr;
  if (clean_val == nullptr || !yyjson_is_str(clean_val)) {
    std::fprintf(stderr, "stdin carries no clean case\n");
    return 1;
  }
  const std::string clean(yyjson_get_str(clean_val), yyjson_get_len(clean_val));
  yyjson_doc_free(cases);
  const double mb = static_cast<double>(clean.size()) / 1024.0 / 1024.0;

  std::string rates;
  auto add = [&](const char *name, double ns) {
    if (!rates.empty()) rates += ",";
    rates += std::string("\"") + name + "\":{\"clean\":" + std::to_string(mb / (ns / 1e9)) + "}";
  };
  auto reject = [](const char *name) {
    std::fprintf(stderr, "%s: DOM does not round-trip the clean document; no rate\n", name);
  };

  if (yyjson_roundtrip(clean) == clean) {
    add("yyjson", estimate_ns([&] {
          yyjson_doc *doc = yyjson_read(clean.data(), clean.size(), 0);
          sink = sink + yyjson_doc_get_val_count(doc);
          yyjson_doc_free(doc);
        }));
  } else reject("yyjson");

  if (rapidjson_roundtrip(clean) == clean) {
    add("rapidjson", estimate_ns([&] {
          rapidjson::Document d;
          d.Parse(clean.data(), clean.size());
          sink = sink + d.Size();
        }));
  } else reject("rapidjson");

  // The padding copy is input preparation simdjson demands of every caller, made once like the
  // other rows' input string; the parser is reused across calls, which is its documented use.
  simdjson::padded_string ps(clean);
  simdjson::dom::parser parser;
  if (simdjson_roundtrip(parser, ps) == clean) {
    add("simdjson", estimate_ns([&] {
          simdjson::dom::element doc;
          if (parser.parse(ps).get(doc) == simdjson::SUCCESS) sink = sink + 1;
        }));
  } else reject("simdjson");

  std::printf("{\"runtime\":\"native yyjson %s rapidjson %s simdjson %s\",\"rates\":{%s}}\n",
              YYJSON_VERSION_STRING, RAPIDJSON_VERSION_STRING, SIMDJSON_VERSION, rates.c_str());
  return 0;
}
