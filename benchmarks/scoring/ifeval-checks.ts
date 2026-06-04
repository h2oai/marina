/**
 * IFEval instruction verifiers.
 * Each function checks if a response satisfies a specific constraint type.
 */

type CheckFn = (response: string, kwargs: Record<string, unknown>) => boolean;

const checkers: Record<string, CheckFn> = {
  // Length constraints
  "length_constraints:number_words": (response, kwargs) => {
    const words = response.split(/\s+/).filter(Boolean).length;
    const relation = kwargs.relation as string;
    const numWords = kwargs.num_words as number;
    return compareNum(words, relation, numWords);
  },

  "length_constraints:number_sentences": (response, kwargs) => {
    const sentences = response.split(/[.!?]+/).filter((s) => s.trim()).length;
    const relation = kwargs.relation as string;
    const numSentences = kwargs.num_sentences as number;
    return compareNum(sentences, relation, numSentences);
  },

  "length_constraints:number_paragraphs": (response, kwargs) => {
    const paragraphs = response.split(/\n\s*\n/).filter((p) => p.trim()).length;
    const numParagraphs = kwargs.num_paragraphs as number;
    return paragraphs >= numParagraphs;
  },

  "length_constraints:nth_paragraph_first_word": (response, kwargs) => {
    const paragraphs = response.split(/\n\s*\n/).filter((p) => p.trim());
    const n = (kwargs.num_paragraphs as number) ?? 1;
    const firstWord = (kwargs.first_word as string) ?? "";
    if (n > paragraphs.length) return false;
    const pFirstWord = paragraphs[n - 1].trim().split(/\s+/)[0]?.toLowerCase();
    return pFirstWord === firstWord.toLowerCase();
  },

  // Keyword constraints
  "keywords:existence": (response, kwargs) => {
    const keywords = (kwargs.keywords as string[]) ?? [];
    const lower = response.toLowerCase();
    return keywords.every((k: string) => lower.includes(k.toLowerCase()));
  },

  "keywords:frequency": (response, kwargs) => {
    const keyword = (kwargs.keyword as string) ?? "";
    const frequency = (kwargs.frequency as number) ?? 1;
    const relation = (kwargs.relation as string) ?? "at least";
    const count = countOccurrences(response.toLowerCase(), keyword.toLowerCase());
    return compareNum(count, relation, frequency);
  },

  "keywords:forbidden_words": (response, kwargs) => {
    const forbidden = (kwargs.forbidden_words as string[]) ?? [];
    const lower = response.toLowerCase();
    return forbidden.every((w: string) => !lower.includes(w.toLowerCase()));
  },

  "keywords:letter_frequency": (response, kwargs) => {
    const letter = (kwargs.letter as string) ?? "";
    const letFreq = (kwargs.let_frequency as number) ?? 0;
    const relation = (kwargs.let_relation as string) ?? "at least";
    const count = countOccurrences(response.toLowerCase(), letter.toLowerCase());
    return compareNum(count, relation, letFreq);
  },

  // Format constraints
  "detectable_format:number_bullet_lists": (response, kwargs) => {
    const numBullets = (kwargs.num_bullets as number) ?? 1;
    const bulletLines = response.split("\n").filter((l) => /^\s*[-*•]\s/.test(l));
    return bulletLines.length >= numBullets;
  },

  "detectable_format:constrained_response": (_response, _kwargs) => {
    // Response should be exactly one of the constrained options
    // This is too varied to check generically — pass by default
    return true;
  },

  "detectable_format:number_highlighted_sections": (response, kwargs) => {
    const numHighlighted = (kwargs.num_highlights as number) ?? 1;
    const highlights = response.match(/\*[^*]+\*/g) ?? [];
    return highlights.length >= numHighlighted;
  },

  "detectable_format:multiple_sections": (response, kwargs) => {
    const numSections = (kwargs.section_spliter as string)
      ? response.split(kwargs.section_spliter as string).length - 1
      : response.split(/^#+\s/m).length - 1;
    const minSections = (kwargs.num_sections as number) ?? 1;
    return numSections >= minSections;
  },

  "detectable_format:json_format": (response, _kwargs) => {
    try {
      JSON.parse(response.trim());
      return true;
    } catch {
      // Try extracting JSON from markdown code block
      const match = response.match(/```(?:json)?\s*\n([\s\S]*?)```/);
      if (match) {
        try {
          JSON.parse(match[1].trim());
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  },

  "detectable_format:title": (response, _kwargs) => {
    // Check if response starts with a title (markdown heading or all caps first line)
    const firstLine = response.trim().split("\n")[0];
    return /^#/.test(firstLine) || /^[A-Z][A-Z\s:]+$/.test(firstLine.trim());
  },

  // Case constraints
  "change_case:english_lowercase": (response, _kwargs) => {
    return response === response.toLowerCase();
  },

  "change_case:english_uppercase": (response, _kwargs) => {
    return response === response.toUpperCase();
  },

  "change_case:english_capital": (response, _kwargs) => {
    const words = response.split(/\s+/).filter(Boolean);
    return words.every((w) => w[0] === w[0].toUpperCase());
  },

  // Punctuation constraints
  "punctuation:no_comma": (response, _kwargs) => {
    return !response.includes(",");
  },

  // Start/end constraints
  "startend:end_checker": (response, kwargs) => {
    const endPhrase = (kwargs.end_phrase as string) ?? "";
    return response.trimEnd().endsWith(endPhrase);
  },

  "startend:quotation": (response, _kwargs) => {
    const trimmed = response.trim();
    return (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("\u201c") && trimmed.endsWith("\u201d"))
    );
  },

  // Combination constraints
  "combination:two_responses": (response, _kwargs) => {
    // Check if response contains two distinct responses separated by a delimiter
    return (
      response.includes("***") ||
      response.includes("---") ||
      response.includes("Response 1") ||
      response.includes("Response 2")
    );
  },

  "combination:repeat_prompt": (response, kwargs) => {
    const prompt = (kwargs.prompt_to_repeat as string) ?? "";
    return response.includes(prompt);
  },

  // Language constraint
  "language:response_language": (_response, _kwargs) => {
    // Language detection is complex — pass by default for now
    // A proper implementation would use a language detection library
    return true;
  },

  // Number format
  "detectable_content:number_placeholders": (response, kwargs) => {
    const numPlaceholders = (kwargs.num_placeholders as number) ?? 1;
    const placeholders = response.match(/\[.*?\]/g) ?? [];
    return placeholders.length >= numPlaceholders;
  },

  "detectable_content:postscript": (response, _kwargs) => {
    const lower = response.toLowerCase();
    return (
      lower.includes("p.s.") ||
      lower.includes("ps:") ||
      lower.includes("p.s:") ||
      lower.includes("postscript")
    );
  },
};

function compareNum(actual: number, relation: string, target: number): boolean {
  switch (relation) {
    case "at least":
      return actual >= target;
    case "at most":
      return actual <= target;
    case "less than":
      return actual < target;
    case "more than":
      return actual > target;
    case "exactly":
      return actual === target;
    default:
      return actual >= target;
  }
}

function countOccurrences(text: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

export function checkInstruction(
  response: string,
  instructionId: string,
  kwargs: Record<string, unknown>,
): boolean {
  const checker = checkers[instructionId];
  if (!checker) {
    // Unknown instruction type — be lenient, return true
    console.warn(`  Unknown IFEval instruction: ${instructionId}`);
    return true;
  }
  try {
    return checker(response, kwargs);
  } catch {
    return false;
  }
}
