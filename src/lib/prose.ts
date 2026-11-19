/**
 * Prose gate — the HARNESS enforces what style.md asks: one English, US
 * spelling, no typos, in everything posted to GitHub. Models wobble between
 * locales ("initialised" next to "behavior") and occasionally typo; nothing
 * reaches a PR with a wrong word. Fixes are deterministic (a curated map,
 * meaning-preserving) and always DECLARED — never silent.
 *
 * Tripwire, not a spellchecker: only curated wrong words are touched, whole
 * words only, prose only (fenced blocks and `inline code` are code, not
 * prose). Unknown words pass — flagging them would block posting on
 * identifiers and vocabulary the map simply doesn't know.
 *
 * The skill mirror lives in skills/heimdall-review/scripts/post-review.mjs.
 */

export interface ProseFix {
  /** lowercase wrong word as written (duplicate words report "the the") */
  wrong: string;
  right: string;
  count: number;
}

/** en-GB -ise/-isation verbs that models emit against a US-spelling codebase. */
const ISE_STEMS = [
  'author', 'categor', 'character', 'custom', 'initial', 'maxim', 'minim',
  'neutral', 'normal', 'optim', 'organ', 'personal', 'prioriti', 'real',
  'recogn', 'sanit', 'serial', 'special', 'standard', 'summar', 'synchron', 'util',
];

/** Curated misspellings and en-GB variants with one unambiguous US form. */
const MANUAL: Record<string, string> = {
  // en-GB → US
  behaviour: 'behavior', behaviours: 'behaviors', behavioural: 'behavioral',
  colour: 'color', colours: 'colors', coloured: 'colored',
  favour: 'favor', favours: 'favors', favoured: 'favored',
  labour: 'labor', neighbour: 'neighbor', neighbours: 'neighbors', neighbourhood: 'neighborhood',
  honour: 'honor', honoured: 'honored', flavour: 'flavor',
  centre: 'center', centres: 'centers', centred: 'centered',
  licence: 'license', licenced: 'licensed', defence: 'defense',
  programme: 'program', programmes: 'programs',
  practise: 'practice', practised: 'practiced',
  analyse: 'analyze', analysed: 'analyzed', analysing: 'analyzing', // "analyses" is correct US too
  amongst: 'among', learnt: 'learned', spelt: 'spelled', dreamt: 'dreamed',
  travelled: 'traveled', travelling: 'traveling', modelling: 'modeling',
  labelled: 'labeled', labelling: 'labeling', judgement: 'judgment',
  enrol: 'enroll', fulfil: 'fulfill', ageing: 'aging',
  // common misspellings
  recieve: 'receive', recieves: 'receives', recieved: 'received', recieving: 'receiving',
  seperate: 'separate', seperated: 'separated', seperately: 'separately', seperation: 'separation',
  definately: 'definitely', neccessary: 'necessary', nessecary: 'necessary',
  independant: 'independent', independance: 'independence',
  dependancy: 'dependency', dependancies: 'dependencies', dependant: 'dependent',
  compatiblity: 'compatibility', availablity: 'availability',
  vulnerablity: 'vulnerability', maintainance: 'maintenance',
  occured: 'occurred', occurance: 'occurrence', occurances: 'occurrences',
  accomodate: 'accommodate', accomodated: 'accommodated', accomodation: 'accommodation',
  adress: 'address', adressed: 'addressed', adresses: 'addresses',
  succesful: 'successful', sucessful: 'successful',
  succesfully: 'successfully', sucessfully: 'successfully',
  enviroment: 'environment', explicity: 'explicitly', explicitely: 'explicitly',
  imediately: 'immediately', immediatly: 'immediately', persistant: 'persistent',
  refered: 'referred', refering: 'referring', prefered: 'preferred',
  transfered: 'transferred', omited: 'omitted', begining: 'beginning', writting: 'writing',
  teh: 'the', adn: 'and', wiht: 'with', taht: 'that', thier: 'their', whcih: 'which',
  reponse: 'response', reponses: 'responses',
  paramter: 'parameter', paramters: 'parameters',
  paramater: 'parameter', paramaters: 'parameters',
  retrun: 'return', retruns: 'returns',
  implementaion: 'implementation', implemenation: 'implementation',
  resouce: 'resource', resouces: 'resources',
  requierd: 'required', requirment: 'requirement', atribute: 'attribute',
  calender: 'calendar', queryed: 'queried',
};

function buildFixes(): Record<string, string> {
  const fixes = { ...MANUAL };
  for (const s of ISE_STEMS) {
    fixes[`${s}ise`] = `${s}ize`;
    fixes[`${s}ises`] = `${s}izes`;
    fixes[`${s}ised`] = `${s}ized`;
    fixes[`${s}ising`] = `${s}izing`;
    fixes[`${s}isation`] = `${s}ization`;
    fixes[`${s}isations`] = `${s}izations`;
  }
  return fixes;
}

export const PROSE_FIXES: Record<string, string> = buildFixes();

/** Whole-word boundaries: `_`, digits and letters glue a word to its neighbors. */
const WORD_START = '(?<![A-Za-z0-9_])';
const WORD_END = '(?![A-Za-z0-9_])';
const FIX_RES: [RegExp, string][] = Object.entries(PROSE_FIXES).map(
  ([wrong, right]) => [new RegExp(`${WORD_START}${wrong}${WORD_END}`, 'gi'), right],
);

/**
 * "the the" is a typo; "had had" and "that that" are English. Adjacent repeats
 * on one line collapse to the first occurrence, which keeps its case.
 */
const DUP_RE = new RegExp(`${WORD_START}([A-Za-z]{2,})[ \\t]+\\1${WORD_END}`, 'gi');
const DUP_KEEP = new Set(['had', 'that']);

/** Fenced blocks and inline code are the author's evidence — never touched. */
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]+`/g;

function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && /[A-Z]/.test(source)) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase() && source.slice(1) === source.slice(1).toLowerCase())
    return replacement[0]?.toUpperCase() + replacement.slice(1);
  return replacement;
}

/**
 * Rewrite prose to the curated US-spelling/typo map. Returns the fixed text
 * and every fix applied — callers must declare the list, never swallow it.
 * Idempotent: running it on its own output changes nothing.
 */
export function fixProse(text: string): { text: string; fixes: ProseFix[] } {
  const fixes = new Map<string, ProseFix>();
  const record = (wrong: string, right: string) => {
    const key = wrong.toLowerCase();
    const hit = fixes.get(key);
    if (hit) hit.count++;
    else fixes.set(key, { wrong: key, right, count: 1 });
  };

  const fixProseSegment = (prose: string): string => {
    let out = prose.replace(DUP_RE, (match, word: string) => {
      if (DUP_KEEP.has(word.toLowerCase())) return match;
      record(`${word} ${word}`, word);
      return word;
    });
    for (const [re, right] of FIX_RES) {
      out = out.replace(re, (word: string) => {
        record(word, right);
        return matchCase(word, right);
      });
    }
    return out;
  };

  let text2 = '';
  let last = 0;
  for (const m of text.matchAll(CODE_SPAN)) {
    text2 += fixProseSegment(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  text2 += fixProseSegment(text.slice(last));
  return { text: text2, fixes: [...fixes.values()] };
}

/** "initialised→initialized, the the→the" — the declared form for logs/JSON. */
export function describeFixes(fixes: ProseFix[]): string {
  return fixes.map((f) => `${f.wrong}→${f.right}${f.count > 1 ? `×${f.count}` : ''}`).join(', ');
}
