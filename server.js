import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("🚀 CallBrief AI API Online");
});

app.post("/briefing", async (req, res) => {
  try {
    const {
      name,
      cargo,
      empresa,
      segmento,
      empresaUsuario,
      modo
    } = req.body;

    const config = empresaUsuario || {};
    const briefingMode = modo || "compact";

    const receivedRole =
      !cargo ||
      cargo.includes("Cargo não encontrado") ||
      cargo.includes("Não identificado") ||
      cargo.includes("Não informado") ||
      cargo.includes("Not found") ||
      cargo.includes("Not identified")
        ? "Role not provided. Infer the most likely role from the page context."
        : cargo;

    const companyContext = `
USER COMPANY USING CALLBRIEF:

Company name:
${config.nome || "Company not configured"}

Product/service sold:
${config.produto || "Product not provided"}

Industry:
${config.segmento || "Industry not provided"}

Target audience:
${config.publicoAlvo || "Target audience not provided"}

Pain points solved:
${config.dores || "Pain points not provided"}

Value proposition:
${config.propostaValor || "Value proposition not provided"}

Common objections:
${config.objecoes || "Common objections not provided"}

Sales tone:
${config.tom || "Consultative, direct and strategic"}
`;

    const leadContext = `
LEAD BEING ANALYZED:

Name:
${name || "Name not provided"}

Received role:
${receivedRole}

Company/page:
${empresa || "Company not provided"}

Extracted page context:
${segmento || "No extracted context"}
`;

    const antiGenericRules = `
MANDATORY RULES:

1. Do NOT sell CallBrief.
2. CallBrief is only the tool. The output must help the USER COMPANY sell its own product/service.
3. Do NOT use generic AI language.
4. Do NOT write like a corporate robot.
5. Do NOT use phrases like:
- "I am excited to discuss"
- "I would love to learn more"
- "Our solution can help"
- "Our software"
- "Our product"
- "I am impressed"
- "It would be a pleasure"
- "How can we help"
- "As an AI"

6. Avoid obvious questions.
7. Avoid exaggerated compliments.
8. Avoid vague claims.
9. Do not invent precise facts that are not supported by context.
10. If the role is missing or bad, infer the likely role from context.
11. If the lead appears to be a founder, executive, head or manager, treat them as a strategic decision-maker.
12. Every pain must be connected to the user company's product/service.
13. Every question must help advance a real sales conversation.
14. Every strategy must include clear commercial logic.
15. The briefing must sound like it was prepared by a senior B2B seller.

STYLE:
- Direct.
- Human.
- Consultative.
- Practical.
- No fluff.
- No long generic paragraphs.
- Use modern B2B sales language.
- Focus on useful hypotheses, not pretty summaries.

QUALITY BAR:
The output should help the seller know:
- why this lead matters;
- what likely matters to the lead;
- what risk or objection may appear;
- what question to ask first;
- how to open the conversation naturally.
`;

    const promptCompact = `
${companyContext}

${leadContext}

${antiGenericRules}

Generate a COMPACT pre-call briefing for a sales rep.

The goal is to give the rep a fast, practical and actionable view before the meeting.

Each field must be short.
Maximum 1 sentence per field.

Return ONLY valid JSON.
Do not include markdown.
Do not include comments.
Do not include explanations outside JSON.

JSON SCHEMA:

{
  "mode": "compact",
  "inferred_role": "",
  "opening_hook": "",
  "main_pain": "",
  "likely_objection": "",
  "best_approach": "",
  "key_question": "",
  "discovery_questions": [
    "",
    "",
    ""
  ]
}
`;

    const promptDeep = `
${companyContext}

${leadContext}

${antiGenericRules}

Generate a strategic pre-call briefing for a senior B2B seller.

The briefing must be specific, useful and commercially actionable.

Do not create generic sales advice.
Create a briefing that feels tailored to this specific lead and to the user company's product/service.

Return ONLY valid JSON.
Do not include markdown.
Do not include comments.
Do not include explanations outside JSON.

JSON SCHEMA:

{
  "mode": "deep",
  "inferred_role": "",
  "ice_breaker": "",
  "profile": "",
  "pain": "",
  "objection": "",
  "strategy": "",
  "discovery_questions": [
    "",
    "",
    ""
  ]
}
`;

    const prompt =
      briefingMode === "deep"
        ? promptDeep
        : promptCompact;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content:
              "You are a senior B2B sales strategist, RevOps expert and consultative discovery coach. You always respond in valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.42
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const text = response.data.choices[0].message.content;

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}") + 1;

    if (start === -1 || end === 0) {
      throw new Error("Invalid JSON returned by AI.");
    }

    const jsonString = text.slice(start, end);
    const briefing = JSON.parse(jsonString);

    res.json(briefing);

  } catch (err) {
    console.log("AI ERROR:", err.response?.data || err.message);

    res.status(500).json({
      error: "Error generating briefing"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 CallBrief AI API running on port ${PORT}`);
});