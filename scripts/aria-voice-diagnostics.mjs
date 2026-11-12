/** Match sherpa 2.x's actual OOV warning as well as other missing-word formats. */
export function missingNativeWords(diagnostics) {
  return /skip(?:ped|ping)?[^\n]*word|word[^\n]*(?:skip(?:ped|ping)?|not found|missing)|(?:not found|missing)[^\n]*lexicon/i.test(
    diagnostics,
  )
}
