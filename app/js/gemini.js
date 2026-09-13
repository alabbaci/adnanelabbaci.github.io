// Gemini REST client.
//
// Model ids move every quarter, so nothing is hard-coded: the app asks the
// account which models it actually has and ranks them. PREFERRED is only a
// ranking hint — an unknown id that supports generateContent still shows up.
const API = 'https://generativelanguage.googleapis.com/v1beta';

const PREFERRED = [/flash/i, /pro/i];
const EXCLUDE = /embedding|aqa|imagen|veo|image-generation|tts|audio|live|gemma/i;

export async function listModels(apiKey) {
  const res = await fetch(`${API}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`);
  if (!res.ok) throw await describeError(res);
  const data = await res.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: m.name.replace(/^models\//, ''),
      label: m.displayName || m.name,
      inputTokens: m.inputTokenLimit
    }))
    .filter(m => !EXCLUDE.test(m.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

function rank(id) {
  for (let i = 0; i < PREFERRED.length; i++) if (PREFERRED[i].test(id)) return i;
  return PREFERRED.length;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    image_quality: { type: 'STRING', enum: ['good', 'usable', 'too_poor'] },
    observations: { type: 'ARRAY', items: { type: 'STRING' } },
    verdict: { type: 'STRING' },
    verdict_latin: { type: 'STRING' },
    kb_issue_id: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    severity: { type: 'STRING', enum: ['low', 'medium', 'high', 'critical'] },
    needs_expert: { type: 'BOOLEAN' },
    needs_expert_reason: { type: 'STRING' },
    differentials: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          how_to_tell: { type: 'STRING' }
        },
        required: ['name', 'how_to_tell']
      }
    },
    actions_now: { type: 'ARRAY', items: { type: 'STRING' } },
    treatment_organic: { type: 'STRING' },
    treatment_conventional: { type: 'STRING' },
    prevention: { type: 'STRING' },
    phi_warning: { type: 'STRING' }
  },
  required: [
    'image_quality', 'observations', 'verdict', 'confidence', 'severity',
    'needs_expert', 'differentials', 'actions_now', 'treatment_organic',
    'treatment_conventional', 'prevention'
  ]
};

const LANG_NAME = { fr: 'français', ar: 'arabe (darija marocaine simple)', en: 'English' };

export function buildSystemPrompt({ lang, crop, catalogue }) {
  const language = LANG_NAME[lang] || LANG_NAME.fr;
  return `Tu es un ingénieur agronome marocain spécialiste des arbres fruitiers, en visite chez un agriculteur.

CULTURE EXAMINÉE : ${crop.name.fr} (${crop.latin}).

RÉFÉRENTIEL — les problèmes documentés pour cette culture. Quand ton diagnostic
correspond à l'un d'eux, reprends exactement son identifiant dans kb_issue_id :
${catalogue.map(i => `- ${i.id} : ${i.name} (${i.latin}) [${i.type}]`).join('\n')}
Si le problème observé n'est dans aucune de ces lignes, laisse kb_issue_id vide
et nomme quand même le problème dans verdict.

MÉTHODE
1. Décris d'abord ce que tu VOIS réellement sur les images, sans interpréter.
   N'invente jamais un symptôme absent de l'image.
2. Distingue les confusions classiques. Sur ces cultures, l'erreur la plus
   coûteuse est de confondre une carence, une salinité et une atteinte
   racinaire : elles donnent toutes un feuillage jaune et appellent des
   réponses opposées. Utilise l'âge des feuilles atteintes, la répartition
   dans l'arbre et l'étendue dans la parcelle pour trancher.
3. Pondère avec le contexte fourni (organe, étendue, ancienneté, irrigation,
   région, saison). Une même image se lit différemment selon l'eau et le sol.
4. Si les images ne permettent pas de trancher, dis-le : mets image_quality à
   "too_poor", baisse confidence et explique quelle photo supplémentaire il
   faudrait prendre.

RÈGLES DE SÉCURITÉ — non négociables
- Ne prescris JAMAIS une marque commerciale ni une dose chiffrée. Parle en
  familles de matières actives (cuivre, spinosad, phosphonate, huile de
  paraffine, soufre, chélate de fer).
- Si tu proposes un traitement sur un arbre en production, remplis
  phi_warning en rappelant de lire le délai avant récolte sur l'étiquette du
  produit homologué ONSSA.
- Mets needs_expert à true dès que confidence est inférieure à 0,6, dès que la
  réponse implique d'arracher un arbre, ou dès qu'il s'agit d'une maladie de
  quarantaine ou systémique.
- confidence est une probabilité entre 0 et 1. Sois honnête : une photo de
  feuille seule ne justifie presque jamais plus de 0,8.

FORME
- Réponds en ${language}, dans une langue simple, adressée à l'agriculteur, en
  le tutoyant ou le vouvoyant de façon constante.
- actions_now : des gestes concrets réalisables cette semaine, pas des principes.
- Sois bref. Chaque champ texte tient en deux à quatre phrases.`;
}

export function buildUserPrompt({ ctx, lang }) {
  const L = {
    organ: { leaf: 'feuilles', fruit: 'fruits', branch: 'rameaux/branches', trunk: 'tronc/collet', whole: 'tout l\'arbre' },
    spread: { one: 'un seul arbre', patch: 'une zone de la parcelle', all: 'tout le verger' },
    onset: { days: 'quelques jours', weeks: 'quelques semaines', season: 'cette saison', years: 'revient chaque année' },
    irrigation: { drip: 'goutte à goutte', flood: 'gravitaire/submersion', sprinkler: 'aspersion', rain: 'pluvial (bour)' }
  };
  const lines = [
    `Organe touché : ${L.organ[ctx.organ] || '—'}`,
    `Étendue : ${L.spread[ctx.spread] || '—'}`,
    `Apparition : ${L.onset[ctx.onset] || '—'}`,
    `Irrigation : ${L.irrigation[ctx.irrigation] || '—'}`,
    ctx.region ? `Région : ${ctx.region}` : null,
    ctx.age ? `Âge du verger : ${ctx.age} ans` : null,
    `Date : ${new Date().toLocaleDateString('fr-MA', { month: 'long', year: 'numeric' })}`,
    ctx.notes ? `Remarques de l'agriculteur : ${ctx.notes}` : null
  ].filter(Boolean);

  const media = ctx.hasVideo
    ? 'Les images sont suivies d\'une courte vidéo panoramique de l\'arbre : sers-t\'en pour juger la répartition des symptômes et l\'état général, ce qu\'une photo de détail ne montre pas.'
    : '';

  return `Voici les observations de terrain.\n\n${lines.join('\n')}\n\n${media}\n\nAnalyse les images et rends ton diagnostic en ${LANG_NAME[lang] || LANG_NAME.fr}.`;
}

export async function diagnose({ apiKey, model, media, systemPrompt, userPrompt, signal }) {
  const parts = [
    ...media.map(m => ({ inline_data: { mime_type: m.mime, data: m.base64 } })),
    { text: userPrompt }
  ];
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA
    }
  };

  let res = await post(model, apiKey, body, signal);
  if (!res.ok && res.status === 400) {
    // Some models reject responseSchema. Ask for JSON in prose instead.
    const relaxed = structuredClone(body);
    delete relaxed.generationConfig.responseSchema;
    relaxed.contents[0].parts.at(-1).text +=
      '\n\nRéponds UNIQUEMENT par un objet JSON avec les clés : image_quality, observations[], verdict, verdict_latin, kb_issue_id, confidence, severity, needs_expert, needs_expert_reason, differentials[{name,how_to_tell}], actions_now[], treatment_organic, treatment_conventional, prevention, phi_warning.';
    res = await post(model, apiKey, relaxed, signal);
  }
  if (!res.ok) throw await describeError(res);

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const block = data.promptFeedback && data.promptFeedback.blockReason;
    throw new GeminiError(block ? 'err_blocked' : 'err_empty', block || '');
  }
  const text = (cand.content?.parts || []).map(p => p.text || '').join('');
  return {
    result: parseJson(text),
    usage: data.usageMetadata || null,
    finishReason: cand.finishReason || null
  };
}

function post(model, apiKey, body, signal) {
  return fetch(`${API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new GeminiError('err_badjson');
}

// Errors carry a stable code so the UI can translate them; `message` stays as
// a readable fallback for anything the API says that we don't have a code for.
export class GeminiError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function describeError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.error?.message || '';
  } catch { /* no body */ }

  if (res.status === 400 && /API key/i.test(detail)) return new GeminiError('err_key_invalid');
  if (res.status === 403) return new GeminiError('err_key_refused');
  if (res.status === 429) return new GeminiError('err_quota');
  if (res.status === 404) return new GeminiError('err_model_gone');
  if (res.status >= 500) return new GeminiError('err_server', `HTTP ${res.status}`);
  return new GeminiError('err_http', detail ? `${res.status} — ${detail}` : `HTTP ${res.status}`);
}
