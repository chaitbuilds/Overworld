// What a code town's agents are told. Three jobs on a real repository: the lead plans (and changes nothing), a test
// writer writes one module's tests first, a change writer makes that module do its part. Each is one session of the
// no-shell, no-prompt runner (town/runner.ts) in its own working copy.
import { describeMap, type MapModule, type TownMap } from './mapper.js';
import { describePlan, MAX_MODULES, PLAN_FILE, type Plan, type PlanModule } from './plan.js';

export interface Brief { prompt: string; system: string; server: string; runChecks: string; handIn: string; activity: string; starting: string }

const SYSTEM = [
  'You are one of a small team of AI engineers working on a real software product. The tool you work in shows the product\'s codebase as a town: each module (a folder of the repository) is a building, and you are standing at the one you work on. People can watch the work from the street.',
  'You work ONLY inside the working copy you are standing in, with the file tools (Read, Grep, Glob, Edit, Write) and the town\'s two tools (run_checks, hand_in). There is no shell, no network and no one to ask: do not try to run commands, install anything or ask questions. A tool call that is refused tells you why; do not retry it another way.',
  'If the repository has a guide for engineers or agents at its top (CLAUDE.md, AGENTS.md, CONTRIBUTING.md or the like), read it before anything else and keep to its invariants and conventions: they are the product\'s rules, and its own checks enforce them.',
  'When your job is done, call hand_in once and stop.',
].join('\n');

const whereOf = (m: MapModule): string => {
  const dirs = m.dirs.map((d) => `${d}/`), loose = m.looseOf !== undefined ? [`the files directly in ${m.looseOf === '.' ? 'the top folder' : `${m.looseOf}/`} (not its other sub-folders)`] : [];
  return [...loose, ...dirs].join(' and ');
};

export function leadBrief(text: string, where: string, map: TownMap): Brief {
  const prompt = [
    `A person stood at ${where} and asked for this, in exactly these words:\n\n    "${text}"\n`,
    `YOU ARE THE LEAD. You change nothing in the product. You read the repository and write the plan: the one file ${PLAN_FILE} at the top of this working copy, and nothing else. Other agents then do the work from your plan, module by module, and the town holds them to it.`,
    '',
    'Read first: the repository\'s own guide, if it has one, then the code the ask is about. Find where the thing really lives before you decide anything: the code is what is true.',
    '',
    'THE TOWN: one building for each module. These are the modules (their folders), with their lines of code and how many test files cover each:',
    describeMap(map),
    '',
    'A NEW MODULE: a module that does not exist yet can be planned too. Name its folder (directly inside a folder whose sub-folders are modules already, in lower case like its neighbours) and mark it "new": true. The town keeps a lot for it in that quarter, and its building rises as its code is written. Where the ask brings a capability of its own (several hundred lines about one thing, which other code only calls), make it a new module beside the others rather than growing an existing one, and keep the existing modules\' part to the wiring. By the town\'s rules a folder needs at least 300 lines of code to be a building of its own: under that, the town counts it with the folder above it, so a new module must be a real piece of the product, not a stub.',
    '',
    'HOW THE WORK IS DONE, which your plan must fit:',
    '- For each module you name, one agent writes that module\'s tests FIRST. It may write only the test files your plan names for that module (and may correct an existing test the change will make wrong). The town runs them: they must fail, and only they.',
    '- Then another agent writes the change. It may write ONLY inside that module\'s own folder. So every file that has to change must lie inside a module you name, and each module\'s part must be something its own tests can prove.',
    '- After each module\'s change the type check and EVERY test of the repository must pass, with the modules after it still unchanged. So a module that others use must change in a way that keeps them compiling until their own turn (add, do not break).',
    '- "needs": a module needs another only when it is written against that module\'s CHANGED code. Modules that do not need each other are worked on at the same time, each by its own agents. Make the order short and wide, not a chain: where you have the choice, put what several modules will share (words, a type, a setting\'s shape) into the one module they all already depend on, so that after it the others need only it and can be worked on side by side.',
    '- When every module is done, each is merged in turn and the repository\'s whole CI runs after each (every step of its CI workflow: the type check, the tests, anything else it checks). The person then approves, and the change goes into the product.',
    '',
    'DECIDE:',
    `1. THE SCOPE. What a careful engineer would ship as ONE change for these words: what was asked, done properly, and no more. At most ${MAX_MODULES} modules; fewer is better. Say in "summary" what the person using the product will find changed.`,
    '2. THE MODULES, what each "does" (exactly: names of new exports, shapes of data, the words of any control), what each needs, and the test files that prove each. Each also has a "sign": the few plain words that stand on a sign at its building while it is worked on, saying what that building gets, for someone walking past who has not read the code (like "prices in euros" or "a darker theme"; no file names, no jargon). Tests live where the repository\'s tests live and are written like them; one test file belongs to one module; a test must be able to fail before the change and pass after it with no browser, database or network. Later agents see only your plan and the code: what you leave vague, two of them will decide differently.',
    '',
    `Write ${PLAN_FILE} in this form:`,
    '{ "summary": "...",',
    '  "modules": [ { "module": "<a module\'s folder path, exactly as listed above (or a new one\'s, with "new": true)>", "new": true | (left out), "sign": "<a few plain words>", "does": "...", "needs": ["<module>", ...], "tests": ["<path of a test file>", ...] }, ... ] }',
    '',
    'run_checks tells you whether the plan can be worked from as written (its form, the modules, the order, the test files). When it can, call hand_in with one sentence.',
  ].join('\n');
  return { prompt, system: SYSTEM, server: 'The town\'s own tools: run_checks says whether your plan can be worked from as written; hand_in ends your job.', runChecks: `Check ${PLAN_FILE} against the town's map: its form, the modules, what needs what, the test files. Returns what is wrong, or that it can be worked from.`, handIn: 'Say the plan is done. Call it once, when run_checks accepts the plan, then stop.', activity: 'reading the repository', starting: `the plan for "${text}"` };
}

function common(text: string, plan: Plan, entry: PlanModule, done: string[]): string[] {
  return [
    `A person asked for this change to the product, in exactly these words:\n\n    "${text}"\n`,
    `The lead planned it over ${plan.modules.length} module${plan.modules.length === 1 ? '' : 's'}. You work on ONE of them: ${entry.module}.`,
    '', describePlan(plan), '',
    `YOUR MODULE, ${entry.module}: ${entry.does}`,
    done.length ? `Already done and in your working copy (read their code, it is what is true): ${done.join(', ')}.` : 'No other module of the plan is done yet: yours does not need them.',
    '',
  ];
}

export function testsBrief(text: string, plan: Plan, entry: PlanModule, mod: MapModule, done: string[], repair?: string): Brief {
  const prompt = [
    ...common(text, plan, entry, done),
    'YOUR JOB IS THE TESTS, NOT THE CHANGE. Another agent makes the change afterwards so that your tests pass, and cannot touch them. So your tests decide what the plan\'s words mean for this module. A change that passes them must be one the person would be glad to have.',
    '',
    `Write exactly ${entry.tests.length === 1 ? 'this file' : 'these files'}: ${entry.tests.join(', ')}.`,
    entry.new ? `${entry.module} is a NEW module: its folder does not exist yet (the change's writer makes it). Your tests import from it as the plan describes; until it exists they fail, as they should.` : '',
    'Read first: the repository\'s own guide, if it has one; this module\'s code; two or three existing tests near yours, for how tests are written here (imports, helpers, what is faked).',
    '- Begin each file with a comment headed THE CHANGE MUST: the few things the change\'s writer has to match exactly because your tests name them (exports and their signatures, the shape of data, exact words and labels). Keep to the plan; where the plan is silent, choose, and write the choice down there.',
    '- Test what this module does for the ask through what it gives the rest of the code, not how it is written inside. Include what must NOT change (the default still behaves as before).',
    '- No browser, database or network: follow the existing tests.',
    '- Your tests must FAIL now, because the thing asked for is not there yet, and pass once this module does its part WITHOUT any later module of the plan. Tests that pass already prove nothing and will be sent back.',
    '- Every other test of the repository must still pass. If this module\'s change will make an EXISTING test wrong, correct that test now, only as far as the change makes it wrong.',
    `You may write only the test files named above, and existing test files you have to correct. run_checks runs every test and says which files fail and why. When your new tests fail for the right reason and nothing else does, call hand_in with one sentence.`,
    repair ? `\nYOUR HAND-IN WAS CHECKED AND SENT BACK:\n${repair}\nCorrect it and hand in again.` : '',
  ].join('\n');
  void mod;
  return { prompt, system: SYSTEM, server: 'The town\'s own tools: run_checks runs the repository\'s tests on your working copy; hand_in ends your job.', runChecks: 'Run every test of the repository on your working copy. Returns which test files fail and why. Your new tests should fail; nothing else should.', handIn: 'Say your tests are written. Call it once, then stop.', activity: `reading ${entry.module}`, starting: `tests of ${entry.module} for "${text}"` };
}

export function changeBrief(text: string, plan: Plan, entry: PlanModule, mod: MapModule, done: string[], repair?: string): Brief {
  const prompt = [
    ...common(text, plan, entry, done),
    `Another agent has already written this module's tests (${entry.tests.join(', ')}). You cannot change them, or any test. YOUR JOB IS THE CHANGE: make ${entry.module} do its part, so that those tests pass, the type check passes, and every other test still passes.`,
    '',
    `You may write ONLY inside this module: ${whereOf(mod)}. Nothing else is yours to edit: not another module, not a test, not the docs. If another module would have to change for yours to work, yours must instead work with that module as it is.`,
    entry.new ? `${entry.module} is a NEW module: its folder does not exist yet. Make it, and put every file of the change inside it, written as the modules beside it are written.` : '',
    'Read first: the repository\'s own guide, if it has one; the tests, starting with their THE CHANGE MUST comment; then the code you will change and what uses it.',
    'What matters, in this order:',
    '1. It does what the plan says for this module, for a person using the product, and its tests pass.',
    '2. Nothing else breaks: the type check covers the whole repository, and other modules still use this one as they did. Add; do not rename or remove what others use.',
    '3. It is written as this repository writes: its conventions, its words, its style. Change as little as the job needs.',
    'run_checks runs the type check and every test and says what failed; use it as often as you like. When everything passes, call hand_in with one or two sentences: what you changed.',
    repair ? `\nYOUR HAND-IN WAS CHECKED AND SENT BACK. This is what was wrong:\n${repair}\nFix it, run the checks, and hand in again.` : '',
  ].join('\n');
  return { prompt, system: SYSTEM, server: 'The town\'s own tools: run_checks runs the type check and every test on your working copy; hand_in ends your job.', runChecks: 'Run the type check and every test of the repository on your working copy. Returns what failed, or that everything passes.', handIn: 'Say your change is done. Call it once, when the checks pass, then stop.', activity: `reading ${entry.module}`, starting: `the change to ${entry.module} for "${text}"` };
}
