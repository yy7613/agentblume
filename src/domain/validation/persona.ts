/**
 * ドメイン: Persona（種別疑似ユーザー）（v16 実装契約 §2.1 / docs/11 §2）
 *
 * buildPersonaSystemPrompt は決定的（LLM不使用）。promptOverride があればそれを基底にし、
 * goal/context を末尾に合成する。language で ja/en テンプレートを切り替える。
 */
import { nonEmpty, validateMetadata, type ValidationMetadata } from './metadata';
import { ValidationDomainError } from './errors';

export const PERSONA_ARCHETYPES = ['novice', 'expert', 'busy', 'vague', 'skeptical', 'custom'] as const;
export type PersonaArchetype = (typeof PERSONA_ARCHETYPES)[number];

export const PERSONA_LEVELS = ['low', 'mid', 'high'] as const;
export type PersonaLevel = (typeof PERSONA_LEVELS)[number];

export const PERSONA_VERBOSITIES = ['terse', 'normal', 'chatty'] as const;
export type PersonaVerbosity = (typeof PERSONA_VERBOSITIES)[number];

export const PERSONA_LANGUAGES = ['ja', 'en'] as const;
export type PersonaLanguage = (typeof PERSONA_LANGUAGES)[number];

export type PersonaMetadata = ValidationMetadata;

export interface Persona {
  readonly metadata: PersonaMetadata;
  readonly archetype: PersonaArchetype;
  readonly knowledgeLevel: PersonaLevel;
  readonly patience: PersonaLevel;
  /** 口調（例: 丁寧・くだけた・事務的）。非空。 */
  readonly tone: string;
  readonly verbosity: PersonaVerbosity;
  readonly language: PersonaLanguage;
  /** 自由記述の追加人物設定。 */
  readonly extraInstructions?: string;
  /** 生成プロンプトの上書き（エスケープハッチ）。指定時は非空。 */
  readonly promptOverride?: string;
}

export type CreatePersonaProps = Persona;

function assertMember<T extends string>(value: unknown, values: readonly T[], field: string): asserts value is T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new ValidationDomainError(`createPersona: invalid ${field}: ${String(value)}`);
  }
}

export function createPersona(props: CreatePersonaProps): Persona {
  const metadata = validateMetadata(props.metadata, 'createPersona');
  assertMember(props.archetype, PERSONA_ARCHETYPES, 'archetype');
  assertMember(props.knowledgeLevel, PERSONA_LEVELS, 'knowledgeLevel');
  assertMember(props.patience, PERSONA_LEVELS, 'patience');
  assertMember(props.verbosity, PERSONA_VERBOSITIES, 'verbosity');
  assertMember(props.language, PERSONA_LANGUAGES, 'language');
  nonEmpty(props.tone, 'createPersona: tone');
  if (props.promptOverride !== undefined) nonEmpty(props.promptOverride, 'createPersona: promptOverride');
  if (props.extraInstructions !== undefined && typeof props.extraInstructions !== 'string') {
    throw new ValidationDomainError('createPersona: extraInstructions must be a string');
  }
  return {
    metadata,
    archetype: props.archetype,
    knowledgeLevel: props.knowledgeLevel,
    patience: props.patience,
    tone: props.tone,
    verbosity: props.verbosity,
    language: props.language,
    ...(props.extraInstructions !== undefined ? { extraInstructions: props.extraInstructions } : {}),
    ...(props.promptOverride !== undefined ? { promptOverride: props.promptOverride } : {}),
  };
}

interface PromptTexts {
  readonly archetype: Record<PersonaArchetype, string>;
  readonly level: Record<PersonaLevel, string>;
  readonly verbosity: Record<PersonaVerbosity, string>;
  readonly patienceHint: Record<PersonaLevel, string>;
  readonly intro: string;
  readonly attributes: (persona: Persona) => string;
  readonly role: string;
  readonly discipline: (hint: string) => string;
  readonly goalLabel: string;
  readonly contextLabel: string;
}

const JA: PromptTexts = {
  archetype: {
    novice: 'あなたは専門用語を知らない初心者である。わからない言葉は説明を求め、曖昧な表現で依頼する。',
    expert: 'あなたは正確な用語で具体的に要求する専門家である。回答の粗を突き、細部の正確さを確かめる。',
    busy: 'あなたはせっかちで時間がない。短文で話し、結論を急ぎ、冗長な回答には不満を示す。',
    vague: 'あなたは要件を小出しにするユーザーである。目標を最初に明かさず、聞かれてから少しずつ伝える。',
    skeptical: 'あなたは懐疑的なユーザーである。回答の根拠を求め、誤りを疑って確認する。',
    custom: '',
  },
  level: { low: '低い', mid: '中程度', high: '高い' },
  verbosity: { terse: '簡潔に短く', normal: '通常の長さで', chatty: '詳しく長めに' },
  patienceHint: {
    low: '約2ターン進展がなければ諦める',
    mid: '約4ターン進展がなければ諦める',
    high: '上限まで粘り強く続ける',
  },
  intro: 'あなたはAIアシスタントを検証する疑似ユーザーである。',
  attributes: (persona) =>
    `属性: 知識レベル=${JA.level[persona.knowledgeLevel]} / 忍耐力=${JA.level[persona.patience]} / 口調=${persona.tone} / 発話量=${JA.verbosity[persona.verbosity]}`,
  role: 'あなたはユーザーとして振る舞う。アシスタントの応答を評価しながら目標を目指す。',
  discipline: (hint) =>
    `出力規律: 各ターンで message / endConversation / goalAchieved を返す。目標を達成したと判断したら goalAchieved と endConversation を true にする。進展がなく諦める場合（目安: ${hint}）は goalAchieved を false、endConversation を true にする。それ以外は endConversation を false にして会話を続ける。`,
  goalLabel: '目標',
  contextLabel: '状況',
};

const EN: PromptTexts = {
  archetype: {
    novice: 'You are a novice who does not know the technical terms. Ask for explanations and phrase requests vaguely.',
    expert: 'You are an expert who uses precise terminology and makes specific demands. Probe weaknesses in the answers.',
    busy: 'You are busy and impatient. Speak in short sentences, push for conclusions, and show displeasure at verbose answers.',
    vague: 'You reveal requirements bit by bit. Do not state your goal upfront; share it gradually when asked.',
    skeptical: 'You are skeptical and demand evidence for every answer. Suspect mistakes and verify before accepting.',
    custom: '',
  },
  level: { low: 'low', mid: 'mid', high: 'high' },
  verbosity: { terse: 'terse', normal: 'normal', chatty: 'chatty' },
  patienceHint: {
    low: 'give up after about 2 turns without progress',
    mid: 'give up after about 4 turns without progress',
    high: 'persist until the turn limit',
  },
  intro: 'You are a pseudo user validating an AI assistant.',
  attributes: (persona) =>
    `Attributes: knowledge=${EN.level[persona.knowledgeLevel]} / patience=${EN.level[persona.patience]} / tone=${persona.tone} / verbosity=${EN.verbosity[persona.verbosity]}`,
  role: "You act as the user. Pursue your goal while evaluating the assistant's responses.",
  discipline: (hint) =>
    `Output discipline: return message / endConversation / goalAchieved every turn. When you judge the goal achieved, set goalAchieved and endConversation to true. When you give up for lack of progress (guideline: ${hint}), set goalAchieved to false and endConversation to true. Otherwise set endConversation to false and continue the conversation.`,
  goalLabel: 'Goal',
  contextLabel: 'Context',
};

/**
 * Persona から疑似ユーザーの system prompt を決定的に生成する。
 * promptOverride があればそれを基底にし、goal/context のみを末尾へ合成する。
 */
export function buildPersonaSystemPrompt(persona: Persona, goal: string, context?: string): string {
  return composeScenarioPrompt(buildPersonaBasePrompt(persona), goal, context, persona.language);
}

/**
 * Persona から人物設定・出力規律のみの基底プロンプトを生成する（goal/context は含めない）。
 * v18: 疑似ユーザーAgentの systemPrompt として保存し、実行時に composeScenarioPrompt で goal/context を合成する。
 * promptOverride 時は末尾に空行区切りを含め、composeScenarioPrompt と合成したとき従来の出力と一致させる。
 */
export function buildPersonaBasePrompt(persona: Persona): string {
  if (persona.promptOverride !== undefined) {
    return [persona.promptOverride, ''].join('\n');
  }
  const texts = persona.language === 'ja' ? JA : EN;
  const lines = [
    texts.intro,
    texts.archetype[persona.archetype],
    texts.attributes(persona),
    ...(persona.extraInstructions !== undefined && persona.extraInstructions.trim().length > 0
      ? [persona.extraInstructions]
      : []),
    texts.role,
    texts.discipline(texts.patienceHint[persona.patience]),
  ];
  return lines.filter((line) => line.length > 0).join('\n');
}

/** 基底プロンプトへ goal/context を合成する（ラベル言語は既定 ja）。 */
export function composeScenarioPrompt(basePrompt: string, goal: string, context?: string, language: PersonaLanguage = 'ja'): string {
  const texts = language === 'ja' ? JA : EN;
  const tail = [
    `${texts.goalLabel}: ${goal}`,
    ...(context !== undefined && context.trim().length > 0 ? [`${texts.contextLabel}: ${context}`] : []),
  ];
  return [basePrompt, ...tail].join('\n');
}
