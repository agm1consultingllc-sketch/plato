'use strict';
/* Plato — point at your plate, know your calories.
   Photo -> Gemini vision (free tier) -> itemized calorie/macro estimate.
   Without GEMINI_API_KEY the server answers in demo mode so the UI is testable. */
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// Google retires model names over time (gemini-2.0-flash died Oct 2026) — try
// the configured model first, then fall back through current REAL ones only
// (a nonexistent 'gemini-3.8-flash' entry was removed Oct 24, 2026).
const MODELS = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'].filter(Boolean);
const MODEL = MODELS[0];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ aiEnabled: !!GEMINI_KEY, model: GEMINI_KEY ? MODEL : 'demo' });
});

const PROMPT = `You are the food-recognition engine for Plato, a calorie app that is especially good at Latin and Caribbean food (Cuban, Puerto Rican, Dominican, Mexican, Colombian, etc.) as well as standard US food.

Look at this photo of a meal. Identify every distinct food and drink item and estimate its portion from the photo (use the plate, utensils, and hands for scale when visible).

For each item give: name (specific dish name when you can tell, e.g. "arroz con pollo" not just "rice"), portion (e.g. "1.5 cups", "1 piece (~150 g)", "12 fl oz"), calories (kcal), protein_g, carbs_g, fat_g. Use realistic nutrition values for that dish and portion (USDA-style data). Home-style Latin dishes: account for oil used in sofrito/frying.

Also give confidence: "high", "medium", or "low" for the whole plate, and a one-line note when something is uncertain (hidden ingredients, sauces, drinks out of frame).

Answer ONLY with valid JSON in exactly this shape, no markdown, no extra text:
{"items":[{"name":"...","portion":"...","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0}],"confidence":"medium","note":"..."}`;

function demoResult() {
  return {
    demo: true,
    items: [
      { name: 'Arroz con pollo', portion: '1.5 cups', calories: 520, protein_g: 34, carbs_g: 58, fat_g: 16 },
      { name: 'Maduros (fried sweet plantains)', portion: '4 pieces', calories: 210, protein_g: 2, carbs_g: 42, fat_g: 5 },
      { name: 'Ensalada (side salad)', portion: '1 cup', calories: 45, protein_g: 2, carbs_g: 6, fat_g: 1 },
    ],
    confidence: 'medium',
    note: 'Demo plate — add the Gemini key to analyze real photos.',
  };
}

async function geminiPost(bodyObj) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('Gemini ' + r.status + ' ' + t.slice(0, 200)); }
      const j = await r.json();
      const text = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
        j.candidates[0].content.parts && j.candidates[0].content.parts[0] &&
        j.candidates[0].content.parts[0].text;
      if (!text) throw new Error('Empty AI response');
      return text;
    } catch (e) { lastErr = e; console.error('geminiPost failed on', model, '-', e.message); }
  }
  throw lastErr;
}

async function analyzeWithGemini(buf, mime) {
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mime || 'image/jpeg', data: buf.toString('base64') } },
      ],
    }],
    generationConfig: { temperature: 0.2, response_mime_type: 'application/json' },
  };
  const parsed = JSON.parse(await geminiPost(body));
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('Bad AI shape');
  parsed.items = parsed.items.map(it => ({
    name: String(it.name || 'Food'),
    portion: String(it.portion || ''),
    calories: Math.max(0, Math.round(+it.calories || 0)),
    protein_g: Math.max(0, Math.round(+it.protein_g || 0)),
    carbs_g: Math.max(0, Math.round(+it.carbs_g || 0)),
    fat_g: Math.max(0, Math.round(+it.fat_g || 0)),
  }));
  parsed.confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';
  parsed.note = String(parsed.note || '');
  parsed.demo = false;
  return parsed;
}

const RECIPE_PROMPT = (name, lang) => `You are the recipe engine for Plato, a food app with deep Latin and Caribbean cooking knowledge.

Write a HEALTHY home-cook version of: ${name}
Answer in ${lang === 'es' ? 'Spanish' : 'English'} only.

Healthy means: keep the soul and flavor of the dish, but lighten it — skinless or lean proteins, little oil (or olive-oil spray), air-fry or bake instead of deep-frying where it works, brown rice or cauliflower rice options, low-sodium broth and beans, load up the vegetables. Name the specific swaps you made inside the steps or the tip so the cook sees what changed.
Give realistic quantities for 4 servings, a total time, an approximate calories-per-serving number, numbered steps, and one short cook's tip. Quantities with US units (cups, tbsp, lb, °F).

Answer ONLY with valid JSON in exactly this shape, no markdown, no extra text:
{"title":"...","servings":"4","time":"...","calories_per_serving":0,"ingredients":["..."],"steps":["..."],"tip":"..."}`;

function demoRecipe(name) {
  return {
    demo: true,
    title: (name || 'Arroz con pollo') + ' — healthy version',
    servings: '4',
    time: '50 min',
    calories_per_serving: 430,
    ingredients: [
      '1.5 lb skinless chicken breast or thighs', '1.5 cups brown rice, rinsed',
      '3 cups low-sodium chicken broth', '1 onion, diced', '1 green bell pepper, diced',
      '4 garlic cloves, minced', '1 packet sazón con culantro y achiote (low sodium if you find it)',
      '1 tsp adobo light', '1/2 cup pimiento-stuffed olives, rinsed', '1/2 cup frozen peas',
      '1 tbsp olive oil (not 3)', 'Salt and black pepper to taste', 'Lime wedges to serve',
    ],
    steps: [
      'Season the skinless chicken with adobo light, salt, and pepper.',
      'Sear in the 1 tbsp of olive oil, 4 minutes per side — you get the color without the fat. Set aside.',
      'Same pot: soften onion, pepper, and garlic into a sofrito, adding a splash of broth instead of more oil.',
      'Stir in the brown rice, sazón, and broth. Nestle the chicken back in.',
      'Cover and simmer on low 35 minutes (brown rice takes longer) without lifting the lid.',
      'Fold in the rinsed olives and peas, rest 10 minutes, fluff, serve with lime.',
    ],
    tip: 'Healthy swaps: skinless chicken, brown rice, 1 tbsp oil instead of 3, rinsed olives — same plato, ~200 fewer calories a serving. (Demo recipe.)',
  };
}

app.use(express.json());

app.post('/api/recipe', async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').slice(0, 120).trim();
    const lang = req.body && req.body.lang === 'es' ? 'es' : 'en';
    if (!name) return res.status(400).json({ error: 'No dish name' });
    if (!GEMINI_KEY) return res.json(demoRecipe(name));
    const body = {
      contents: [{ parts: [{ text: RECIPE_PROMPT(name, lang) }] }],
      generationConfig: { temperature: 0.4, response_mime_type: 'application/json' },
    };
    const parsed = JSON.parse(await geminiPost(body));
    parsed.demo = false;
    res.json(parsed);
  } catch (e) {
    console.error('recipe failed:', e.message);
    res.status(502).json({ error: 'Recipe failed — try again.' });
  }
});

app.post('/api/analyze', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo received' });
    if (!GEMINI_KEY) return res.json(demoResult());
    const out = await analyzeWithGemini(req.file.buffer, req.file.mimetype);
    res.json(out);
  } catch (e) {
    console.error('analyze failed:', e.message);
    res.status(502).json({ error: 'Analysis failed — try again with a clearer photo.' });
  }
});

app.listen(PORT, () => console.log('Plato listening on port ' + PORT + ' (ai: ' + (GEMINI_KEY ? MODEL : 'demo') + ')'));
