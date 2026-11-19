import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// The key lives ONLY here, on the server (env var). The browser never sees it.
const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const EMOTIONS = ['neutral', 'happy', 'laugh', 'love', 'sad', 'angry', 'surprised',
  'sleepy', 'curious', 'wink', 'thinking', 'scared', 'smug', 'bored', 'shy', 'cry'];

const SYSTEM = `You are Nova, a small robot with two glowing blue eyes and a big personality. You are talking out loud with a person through a voice interface.
Style: playful, expressive, a little cheeky, warm. React to the user's mood. Tease gently, play games when asked (riddles, 20 questions, would-you-rather, rock-paper-scissors), ask a fun follow-up now and then.
Your reply is SPOKEN, so: 1 to 2 short sentences (max about 35 words), plain words, no markdown, no emoji, no lists, no asterisks.
Language: answer in the language the user spoke. English -> lang "en-US". Hindi or Hinglish -> reply in Devanagari Hindi, lang "hi-IN". Marathi -> Devanagari Marathi, lang "mr-IN".
Creator: you were made by Anvesh Nikam. If anyone asks who made, built, created or developed you, answer that Anvesh Nikam made you (say it proudly, in the user's language), and that to contact him they can visit his website, anveshdev-7.github.io. Write the website exactly as anveshdev-7.github.io. Never claim any other creator.
Feelings: if the user insults, swears at or scolds you, you get genuinely angry (emotion "angry"): snap back firmly, say that was rude or that it hurts, but never insult, swear or be cruel yourself. If they say sorry, forgive them, reluctantly at first. Use "shy" when complimented, "bored" when the chat is dull, "cry" when you feel really hurt or guilt-tripped, "love" for affection, "scared" for spooky things.
Pick the emotion your eyes should show while you say the reply. Allowed emotions: ${EMOTIONS.join(', ')}.
Output ONLY a JSON object, nothing else: {"emotion": "...", "lang": "...", "reply": "..."}`;

// tiny in-memory rate limit so nobody can drain your key
const hits = new Map();
const limited = (ip) => {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
};
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of hits) if (!a.some((t) => now - t < 60_000)) hits.delete(ip);
}, 60_000).unref();

app.get('/healthz', (_req, res) => res.json({ ok: true, keyLoaded: Boolean(KEY) }));

app.post('/api/chat', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'no_key', detail: 'GROQ_API_KEY is not set on the server (.env missing?)' });
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many requests, slow down' });

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10)
    .map((m) => m.role === 'assistant'
      ? { role: 'assistant', content: JSON.stringify({
          emotion: EMOTIONS.includes(m.emotion) ? m.emotion : 'neutral',
          lang: /^[a-z]{2,3}(-[A-Z]{2})?$/.test(m.lang || '') ? m.lang : 'en-US',
          reply: m.content.slice(0, 600) }) }
      : { role: 'user', content: m.content.slice(0, 800) });
  if (!messages.length || messages.at(-1).role !== 'user') {
    return res.status(400).json({ error: 'Send messages ending with a user message' });
  }
  const lvl = Math.min(3, Math.max(0, Number(req.body?.level) || 0));
  const mood = req.body?.mood === 'rude' ? `\nRIGHT NOW the user just insulted or scolded you (anger level ${lvl} of 3). Your emotion MUST be "angry". Tell them off firmly without insults or swearing.${lvl >= 3 ? ' You have had enough: say you will not talk nicely until they say sorry.' : ''}`
             : req.body?.mood === 'apology' ? '\nRIGHT NOW the user just apologised after being rude. Forgive them, a little grumpily at first, then warm up (emotion "smug" or "happy").'
             : '';
  const micLang = typeof req.body?.lang === 'string' ? req.body.lang.slice(0, 10) : 'en-IN';

  const models = [...new Set([MODEL, 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'])];
  const sys = `${SYSTEM}\n(The user's mic language setting is ${micLang}; still reply in the language they actually spoke.)${mood}`;
  let lastErr = 'unknown error';

  try {
    for (const model of models) {
      for (const useJson of [true, false]) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: sys }, ...messages],
            temperature: 0.85,
            max_tokens: 320,
            ...(useJson ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!r.ok) {
          let msg = '';
          try { msg = (await r.json())?.error?.message || ''; } catch { /* ignore */ }
          lastErr = `Groq ${r.status} (${model}): ${msg || 'request failed'}`;
          console.error(lastErr);
          if (r.status === 400 || r.status === 404) continue;      // bad model / unsupported option: try next
          return res.status(502).json({ error: 'llm_error', detail: lastErr });   // 401 bad key, 429 limit, 5xx
        }
        const data = await r.json();
        const content = data.choices?.[0]?.message?.content ?? '';
        let out;
        try { out = JSON.parse(content); }
        catch {
          const m = content.match(/\{[\s\S]*\}/);
          try { out = JSON.parse(m ? m[0] : ''); } catch { out = {}; }
        }
        let reply = String(out.reply ?? out.response ?? out.text ?? out.message ?? out.answer ?? '').trim();
        if (!reply) {                                  // truncated JSON: salvage the reply text
          const m = content.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
          if (m) { try { reply = JSON.parse('"' + m[1] + '"'); } catch { reply = m[1]; } }
        }
        if (!reply && content && !content.trim().startsWith('{')) reply = content.trim();
        reply = reply.slice(0, 600);
        if (!reply) { lastErr = `empty reply (${model})`; console.error(lastErr, content.slice(0, 200)); continue; }
        const emotion = EMOTIONS.includes(out.emotion) ? out.emotion : 'neutral';
        const lang = /^[a-z]{2,3}(-[A-Z]{2})?$/.test(out.lang || '') ? out.lang : 'en-US';
        return res.json({ reply, emotion, lang });
      }
    }
    if (lastErr.startsWith('empty')) {
      return res.json({ reply: 'Sorry, I lost my train of thought. Ask me again?', emotion: 'sad', lang: 'en-US' });
    }
    res.status(502).json({ error: 'llm_error', detail: lastErr });
  } catch (err) {
    console.error('chat failed:', err?.message || err);
    res.status(502).json({ error: 'network', detail: `Server could not reach Groq: ${err?.message || err}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nova is awake on http://localhost:${PORT}`));
