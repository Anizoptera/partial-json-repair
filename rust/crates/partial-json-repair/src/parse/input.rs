//! Borrow stream chunks in their existing representation without requiring caller-side conversion.

use super::Input;
use alloc::borrow::{Cow, ToOwned};
use alloc::boxed::Box;
use alloc::rc::Rc;
use alloc::string::String;
#[cfg(target_has_atomic = "ptr")]
use alloc::sync::Arc;
use alloc::vec::Vec;

/// A text, byte or UTF-16 chunk that can lend its original input while its drain is active.
///
/// Implement this for a transport's chunk wrapper to preserve its encoding and slice boundaries.
/// Use [`Input`] directly when successive chunks have different representations.
/// A wrapper implementing only `AsRef<str>` can return `Input::Text(self.as_ref())` here.
/// A blanket `AsRef<str>` implementation would overlap byte-buffer implementations; keeping one
/// trait avoids an extra representation parameter on every generic transport type and call.
pub trait AsInput {
    /// Borrow the chunk without decoding, copying or changing its original position units.
    fn as_input(&self) -> Input<'_>;

    /// Whether this slice ends its caller-visible chunk.
    #[doc(hidden)]
    fn final_slice(&self) -> bool {
        true
    }
}

/// One bounded transport slice that retains its caller-visible chunk boundary.
#[doc(hidden)]
pub struct InputSlice<C> {
    chunk: C,
    final_slice: bool,
}

impl<C> InputSlice<C> {
    /// Binds a source slice to its finality within one logical chunk.
    #[must_use]
    pub const fn new(chunk: C, final_slice: bool) -> Self {
        Self { chunk, final_slice }
    }
}

impl<C: AsInput> AsInput for InputSlice<C> {
    fn as_input(&self) -> Input<'_> {
        self.chunk.as_input()
    }

    fn final_slice(&self) -> bool {
        self.final_slice
    }
}

impl AsInput for Input<'_> {
    fn as_input(&self) -> Input<'_> {
        *self
    }
}

impl AsInput for str {
    fn as_input(&self) -> Input<'_> {
        Input::Text(self)
    }
}

impl AsInput for [u8] {
    fn as_input(&self) -> Input<'_> {
        Input::Bytes(self)
    }
}

impl AsInput for [u16] {
    fn as_input(&self) -> Input<'_> {
        Input::Utf16(self)
    }
}

impl<T: AsInput + ?Sized> AsInput for &T {
    fn as_input(&self) -> Input<'_> {
        (**self).as_input()
    }
}

impl<T: AsInput + ?Sized> AsInput for &mut T {
    fn as_input(&self) -> Input<'_> {
        (**self).as_input()
    }
}

impl AsInput for String {
    fn as_input(&self) -> Input<'_> {
        self.as_str().as_input()
    }
}

impl<T> AsInput for Vec<T>
where
    [T]: AsInput,
{
    fn as_input(&self) -> Input<'_> {
        self.as_slice().as_input()
    }
}

impl<T, const N: usize> AsInput for [T; N]
where
    [T]: AsInput,
{
    fn as_input(&self) -> Input<'_> {
        self.as_slice().as_input()
    }
}

impl<T: AsInput + ?Sized> AsInput for Box<T> {
    fn as_input(&self) -> Input<'_> {
        (**self).as_input()
    }
}

impl<T: AsInput + ?Sized> AsInput for Rc<T> {
    fn as_input(&self) -> Input<'_> {
        (**self).as_input()
    }
}

#[cfg(target_has_atomic = "ptr")]
impl<T: AsInput + ?Sized> AsInput for Arc<T> {
    fn as_input(&self) -> Input<'_> {
        (**self).as_input()
    }
}

impl<T: AsInput + ToOwned + ?Sized> AsInput for Cow<'_, T> {
    fn as_input(&self) -> Input<'_> {
        self.as_ref().as_input()
    }
}
