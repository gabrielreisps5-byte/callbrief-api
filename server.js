import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

dotenv.config();

const app = express();

app.use(cors());

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const STRIPE_FOUNDING_MONTHLY_PRICE_ID =
  process.env.STRIPE_FOUNDING_MONTHLY_PRICE_ID;

const STRIPE_FOUNDING_ANNUAL_PRICE_ID =
  process.env.STRIPE_FOUNDING_ANNUAL_PRICE_ID;

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY)
  : null;

if (!GROQ_API_KEY) {
  console.warn("⚠️ Missing GROQ_API_KEY");
}

if (!SUPABASE_URL) {
  console.warn("⚠️ Missing SUPABASE_URL");
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Missing SUPABASE_SERVICE_ROLE_KEY");
}

if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️ Missing STRIPE_SECRET_KEY");
}

if (!STRIPE_WEBHOOK_SECRET) {
  console.warn("⚠️ Missing STRIPE_WEBHOOK_SECRET");
}

if (!STRIPE_FOUNDING_MONTHLY_PRICE_ID) {
  console.warn("⚠️ Missing STRIPE_FOUNDING_MONTHLY_PRICE_ID");
}

if (!STRIPE_FOUNDING_ANNUAL_PRICE_ID) {
  console.warn("⚠️ Missing STRIPE_FOUNDING_ANNUAL_PRICE_ID");
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

function cleanText(value) {
  return String(value || "").trim();
}

function isMissingRole(role) {
  const value = cleanText(role).toLowerCase();

  if (!value) return true;

  const invalidRoles = [
    "cargo não encontrado",
    "cargo nao encontrado",
    "não identificado",
    "nao identificado",
    "não informado",
    "nao informado",
    "not found",
    "not identified",
    "role not found",
    "role not used for crm",
    "crm card not detected",
    "company not used"
  ];

  return invalidRoles.some((item) => value.includes(item));
}

function hasWeakLeadContext({ name, cargo, empresa, segmento }) {
  const context = cleanText(segmento);
  const roleMissing = isMissingRole(cargo);
  const companyMissing =
    !empresa ||
    cleanText(empresa).toLowerCase().includes("company not used") ||
    cleanText(empresa).toLowerCase().includes("company not found");

  const nameMissing =
    !name ||
    cleanText(name).toLowerCase().includes("name not found") ||
    cleanText(name).toLowerCase().includes("not found");

  if (nameMissing) return true;
  if (roleMissing && companyMissing) return true;
  if (context.length < 600) return true;

  return false;
}

function safeJsonParseFromAI(text) {
  const raw = cleanText(text);

  if (!raw) {
    throw new Error("Empty AI response.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}") + 1;

    if (start === -1 || end <= 0) {
      throw new Error("Invalid JSON returned by AI.");
    }

    const jsonString = raw.slice(start, end);
    return JSON.parse(jsonString);
  }
}

function normalizeQuestions(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanText(item))
      .filter(Boolean)
      .slice(0, 3);
  }

  return [];
}

function normalizeBriefingPayload(payload, mode) {
  if (mode === "deep") {
    return {
      mode: "deep",
      inferred_role: cleanText(payload.inferred_role),
      ice_breaker: cleanText(payload.ice_breaker),
      profile: cleanText(payload.profile),
      pain: cleanText(payload.pain),
      objection: cleanText(payload.objection),
      strategy: cleanText(payload.strategy),
      discovery_questions: normalizeQuestions(payload.discovery_questions)
    };
  }

  return {
    mode: "compact",
    inferred_role: cleanText(payload.inferred_role),
    opening_hook: cleanText(payload.opening_hook),
    main_pain: cleanText(payload.main_pain),
    likely_objection: cleanText(payload.likely_objection),
    best_approach: cleanText(payload.best_approach),
    key_question: cleanText(payload.key_question),
    discovery_questions: normalizeQuestions(payload.discovery_questions)
  };
}

function buildCompanyContext(config = {}) {
  return `
USER COMPANY USING OCTIQ:

Company name:
${cleanText(config.nome) || "Company not configured"}

Product/service sold:
${cleanText(config.produto) || "Product not provided"}

Industry:
${cleanText(config.segmento) || "Industry not provided"}

Target audience:
${cleanText(config.publicoAlvo) || "Target audience not provided"}

Pain points solved:
${cleanText(config.dores) || "Pain points not provided"}

Value proposition:
${cleanText(config.propostaValor) || "Value proposition not provided"}

Common objections:
${cleanText(config.objecoes) || "Common objections not provided"}

Sales tone:
${cleanText(config.tom) || "Consultative, direct and strategic"}
`;
}

function buildLeadContext({ name, cargo, empresa, segmento }) {
  const receivedRole = isMissingRole(cargo)
    ? "Role not provided. Infer the most likely role from context only if there is enough evidence."
    : cleanText(cargo);

  const companyValue = cleanText(empresa);

  const weakContext = hasWeakLeadContext({
    name,
    cargo,
    empresa,
    segmento
  });

  return `
LEAD BEING ANALYZED:

Name:
${cleanText(name) || "Name not provided"}

Received role:
${receivedRole}

Company/page:
${companyValue && companyValue !== "Company not used" ? companyValue : "Company intentionally not used"}

Lead context strength:
${weakContext ? "WEAK_CONTEXT" : "NORMAL_CONTEXT"}

Extracted page or CRM context:
${cleanText(segmento) || "No extracted context"}
`;
}

const antiGenericRules = `
MANDATORY RULES:

1. Do NOT sell OctIQ. OctIQ is only the internal tool.
2. The output must help the USER COMPANY sell its own product/service.
3. Do NOT invent precise facts that are not supported by context.
4. If information is weak, frame it as a hypothesis, not as certainty.
5. Do NOT overpraise the lead.
6. Do NOT write emotional compliments.
7. Do NOT write phrases like:
- "I was impressed"
- "I admire"
- "Congratulations on your determination"
- "I would love to learn more"
- "I am excited to discuss"
- "Our solution can help"
- "Our product"
- "As an AI"
- "It would be a pleasure"
8. Do not mention missing company data.
9. Do not mention that data extraction failed.
10. If the role is missing, infer a likely role only when context supports it.
11. If role confidence is low, use a broader label such as:
- "Business professional"
- "Operations profile"
- "Commercial profile"
- "Financial market professional"
- "Potential stakeholder"
12. Every pain must connect to the user company's product/service.
13. Every discovery question must help advance a real sales conversation.
14. The briefing must sound like it was prepared by a senior B2B seller.
15. Keep the language direct, human, consultative and practical.
16. Avoid saying the lead "is looking for" something unless the context clearly says so.
17. Avoid saying the lead has a pain unless there is evidence. Prefer "may be worth exploring whether..." when evidence is weak.
18. Never make the lead sound more senior than the context supports.
19. If the lead is likely not a decision-maker, focus the strategy on discovery, qualification and mapping the buying process.
20. Keep the output useful for a sales rep, not pretty for a report.

ICE BREAKER RULES:

The ice breaker or opening hook must:
- reference a concrete context signal;
- sound natural for a sales conversation;
- avoid flattery;
- avoid emotional praise;
- connect to business context when possible.

Good examples:
- "I saw your focus on financial markets and client service. How are you currently thinking about improving productivity across commercial routines?"
- "I noticed your background includes prospecting and client portfolio management. How do you currently organize follow-ups and commercial priorities?"
- "I saw your recent certification update. Are you currently applying that knowledge more in client acquisition, portfolio management or internal operations?"

Bad examples:
- "I was impressed by your determination."
- "Congratulations on your inspiring journey."
- "Your profile is amazing."
- "I would love to learn more about your story."

QUALITY BAR:

The seller should understand:
- why this lead might matter;
- what likely matters to the lead;
- what pain could be explored;
- what objection may appear;
- what to ask first;
- how to open the conversation naturally;
- whether this is a strong lead or just a discovery opportunity.
`;

const weakContextRules = `
WEAK CONTEXT RULES:

If Lead context strength is WEAK_CONTEXT:
1. Be conservative.
2. Do not assume strong buying intent.
3. Do not assume the lead is a decision-maker.
4. Do not create aggressive pain claims.
5. Use language like:
- "worth validating"
- "may be relevant"
- "could be explored"
- "possible angle"
6. The strategy should focus on qualification, not closing.
7. The discovery questions should uncover:
- current workflow;
- decision process;
- priority level;
- pain intensity;
- whether the lead owns or influences the problem.
8. Avoid HIGH certainty language.
`;

function buildCompactPrompt(companyContext, leadContext) {
  return `
${companyContext}

${leadContext}

${antiGenericRules}

${weakContextRules}

Generate a COMPACT pre-call briefing for a sales rep.

The goal is to give the rep a fast, practical and actionable view before the meeting.

Rules for compact mode:
- Each field must be short.
- Maximum 1 sentence per field.
- Discovery questions must be specific and useful.
- Avoid generic questions that could apply to anyone.
- If the lead data is weak, be conservative.
- Opening hook must not sound like praise.
- Main pain must be phrased as a hypothesis if not explicit.
- Best approach must tell the seller what to do in the call.

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
}

function buildDeepPrompt(companyContext, leadContext) {
  return `
${companyContext}

${leadContext}

${antiGenericRules}

${weakContextRules}

Generate a strategic pre-call briefing for a senior B2B seller.

Rules for deep mode:
- Be specific, useful and commercially actionable.
- Do not write long generic paragraphs.
- Use strong sales reasoning.
- If the lead data is weak, clearly keep the analysis as a hypothesis.
- Focus on what the seller should do in the call.
- Ice breaker must be natural and business-oriented, not complimentary.
- Pain must be commercially relevant, but not invented.
- Strategy must include qualification logic when decision authority is unclear.

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
}

async function callGroq(prompt) {
  if (!GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY environment variable.");
  }

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: GROQ_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a senior B2B sales strategist, RevOps expert and consultative discovery coach. You always respond with valid JSON only. You are direct, commercially realistic, and never overhype weak lead data."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.28,
      max_tokens: 1200
    },
    {
      timeout: 45000,
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data?.choices?.[0]?.message?.content || "";
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  return authHeader.replace("Bearer ", "").trim();
}

function isTrialExpired(profile) {
  if (profile.status !== "trialing") return false;
  if (!profile.trial_ends_at) return false;

  return new Date(profile.trial_ends_at).getTime() < Date.now();
}

function isPaidOrTrial(profile) {
  const validStatuses = ["active", "trialing"];

  const paidPlans = [
    "trial",
    "founding_monthly",
    "founding_yearly",
    "pro_monthly",
    "pro_yearly",
    "team"
  ];

  return validStatuses.includes(profile.status) && paidPlans.includes(profile.plan);
}

function canUseDeep(profile) {
  return isPaidOrTrial(profile);
}

function canUseFollowup(profile) {
  return isPaidOrTrial(profile);
}

function sanitizeProfile(profile) {
  return {
    email: profile.email,
    name: profile.name,
    plan: profile.plan,
    status: profile.status,
    briefing_limit: profile.briefing_limit,
    briefing_used: profile.briefing_used,
    followup_limit: profile.followup_limit,
    followup_used: profile.followup_used,
    trial_ends_at: profile.trial_ends_at,
    current_period_end: profile.current_period_end
  };
}

async function getAuthenticatedProfile(req) {
  if (!supabase) {
    const error = new Error("Supabase is not configured.");
    error.status = 500;
    throw error;
  }

  const token = getBearerToken(req);

  if (!token) {
    const error = new Error("Login required.");
    error.status = 401;
    throw error;
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData?.user) {
    const error = new Error("Invalid or expired session.");
    error.status = 401;
    throw error;
  }

  const user = userData.user;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    const error = new Error("User profile not found.");
    error.status = 403;
    throw error;
  }

  if (isTrialExpired(profile)) {
    await supabase
      .from("profiles")
      .update({
        plan: "free",
        status: "active",
        briefing_limit: 5,
        followup_limit: 0,
        updated_at: new Date().toISOString()
      })
      .eq("id", profile.id);

    const error = new Error("Your trial expired. Upgrade to keep using Pro features.");
    error.status = 403;
    throw error;
  }

  return {
    user,
    profile
  };
}

async function incrementUsage(profile, type) {
  const updatePayload = {
    updated_at: new Date().toISOString()
  };

  if (type === "briefing") {
    updatePayload.briefing_used = Number(profile.briefing_used || 0) + 1;
  }

  if (type === "followup") {
    updatePayload.followup_used = Number(profile.followup_used || 0) + 1;
  }

  const { error } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("id", profile.id);

  if (error) {
    console.error("USAGE UPDATE ERROR:", error);
  }
}

async function logUsage(profile, payload = {}) {
  if (!supabase || !profile?.id) return;

  const { error } = await supabase
    .from("usage_logs")
    .insert({
      user_id: profile.id,
      action: payload.action || "unknown",
      mode: payload.mode || null,
      source: payload.source || null,
      lead_name: payload.lead_name || null,
      lead_role: payload.lead_role || null
    });

  if (error) {
    console.error("USAGE LOG ERROR:", error);
  }
}

async function logStripeEventWithoutProfile(payload = {}) {
  console.warn("STRIPE EVENT WITHOUT PROFILE:", payload);
}

async function activateFoundingPlanByEmail({
  email,
  plan,
  stripeCustomerId,
  stripeSubscriptionId
}) {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) {
    throw new Error("Missing customer email.");
  }

  const isAnnual = plan === "founding_yearly";

  const updatePayload = {
    plan,
    status: "active",
    briefing_limit: isAnnual ? 3600 : 300,
    briefing_used: 0,
    followup_limit: isAnnual ? 1200 : 100,
    followup_used: 0,
    trial_ends_at: null,
    current_period_end: isAnnual
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("email", normalizedEmail)
    .select("id,email,plan,status")
    .single();

  if (error || !data) {
    console.error("STRIPE PROFILE UPDATE ERROR:", error);

    await logStripeEventWithoutProfile({
      email: normalizedEmail,
      plan,
      stripeCustomerId,
      stripeSubscriptionId
    });

    throw new Error(
      `Payment received, but no OctIQ profile found for email: ${normalizedEmail}`
    );
  }

  const { error: logError } = await supabase
    .from("usage_logs")
    .insert({
      user_id: data.id,
      action: "stripe_payment_activated",
      mode: plan,
      source: "stripe",
      lead_name: normalizedEmail,
      lead_role: stripeSubscriptionId || null
    });

  if (logError) {
    console.error("STRIPE USAGE LOG ERROR:", logError);
  }

  return data;
}

async function getPriceIdFromCheckoutSession(session) {
  if (!stripe) {
    throw new Error("Stripe is not configured.");
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 5
  });

  return lineItems?.data?.[0]?.price?.id || "";
}

async function handleStripeWebhook(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("Stripe webhook is not configured.");
  }

  const signature = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("STRIPE WEBHOOK SIGNATURE ERROR:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const customerEmail =
        session.customer_details?.email ||
        session.customer_email ||
        "";

      const priceId = await getPriceIdFromCheckoutSession(session);

      let plan = "";

      if (priceId === STRIPE_FOUNDING_MONTHLY_PRICE_ID) {
        plan = "founding_monthly";
      }

      if (priceId === STRIPE_FOUNDING_ANNUAL_PRICE_ID) {
        plan = "founding_yearly";
      }

      if (!plan) {
        console.warn("STRIPE WEBHOOK UNKNOWN PRICE:", {
          priceId,
          sessionId: session.id
        });

        return res.json({
          received: true,
          ignored: true,
          reason: "unknown_price"
        });
      }

      await activateFoundingPlanByEmail({
        email: customerEmail,
        plan,
        stripeCustomerId:
          typeof session.customer === "string" ? session.customer : null,
        stripeSubscriptionId:
          typeof session.subscription === "string"
            ? session.subscription
            : null
      });

      console.log("✅ Stripe payment activated:", {
        email: customerEmail,
        plan,
        priceId
      });
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("STRIPE WEBHOOK HANDLER ERROR:", err.message);

    return res.status(500).json({
      received: true,
      error: err.message
    });
  }
}

app.get("/", (req, res) => {
  res.send("🚀 OctIQ API Online");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "OctIQ API",
    groqConfigured: Boolean(GROQ_API_KEY),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    stripeConfigured: Boolean(STRIPE_SECRET_KEY),
    stripeWebhookConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
    model: GROQ_MODEL,
    timestamp: new Date().toISOString()
  });
});

app.get("/me", async (req, res) => {
  try {
    const { profile } = await getAuthenticatedProfile(req);

    res.json({
      ok: true,
      profile: sanitizeProfile(profile)
    });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Error loading profile."
    });
  }
});

app.post("/start-trial", async (req, res) => {
  try {
    const { profile } = await getAuthenticatedProfile(req);

    if (profile.plan !== "free") {
      return res.status(400).json({
        ok: false,
        error: "Trial is only available for Free users."
      });
    }

    if (profile.trial_ends_at) {
      return res.status(400).json({
        ok: false,
        error: "Trial already used on this account."
      });
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 7);

    const { data: updatedProfile, error } = await supabase
      .from("profiles")
      .update({
        plan: "trial",
        status: "trialing",
        briefing_limit: 300,
        briefing_used: 0,
        followup_limit: 100,
        followup_used: 0,
        trial_ends_at: trialEndsAt.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", profile.id)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    await logUsage(profile, {
      action: "trial_started"
    });

    res.json({
      ok: true,
      profile: sanitizeProfile(updatedProfile)
    });
  } catch (err) {
    console.error("START TRIAL ERROR:", err.response?.data || err.message);

    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Error starting trial."
    });
  }
});

app.post("/briefing", async (req, res) => {
  try {
    const { profile } = await getAuthenticatedProfile(req);

    if (profile.status !== "active" && profile.status !== "trialing") {
      return res.status(403).json({
        error: "Subscription inactive."
      });
    }

    if (Number(profile.briefing_used || 0) >= Number(profile.briefing_limit || 0)) {
      return res.status(403).json({
        error: "Monthly briefing limit reached. Upgrade your plan to keep generating briefings."
      });
    }

    const {
      name,
      cargo,
      empresa,
      segmento,
      empresaUsuario,
      modo
    } = req.body || {};

    const config = empresaUsuario || {};
    const briefingMode = modo === "deep" ? "deep" : "compact";

    if (!config.produto) {
      return res.status(400).json({
        error: "Missing user company product/service configuration."
      });
    }

    if (briefingMode === "deep" && !canUseDeep(profile)) {
      return res.status(403).json({
        error: "Deep Mode is available on Pro. Start your 7-day trial to unlock it."
      });
    }

    const companyContext = buildCompanyContext(config);

    const leadContext = buildLeadContext({
      name,
      cargo,
      empresa,
      segmento
    });

    const prompt =
      briefingMode === "deep"
        ? buildDeepPrompt(companyContext, leadContext)
        : buildCompactPrompt(companyContext, leadContext);

    const aiText = await callGroq(prompt);
    const parsed = safeJsonParseFromAI(aiText);
    const briefing = normalizeBriefingPayload(parsed, briefingMode);

    await incrementUsage(profile, "briefing");

    await logUsage(profile, {
      action: "briefing",
      mode: briefingMode,
      source: req.body?.source || null,
      lead_name: name || null,
      lead_role: cargo || null
    });

    res.json(briefing);
  } catch (err) {
    console.error("BRIEFING ERROR:", err.response?.data || err.message);

    res.status(err.status || 500).json({
      error: err.message || "Error generating briefing",
      details:
        process.env.NODE_ENV === "production"
          ? undefined
          : err.response?.data || err.message
    });
  }
});

app.post("/followup", async (req, res) => {
  try {
    const { profile } = await getAuthenticatedProfile(req);

    if (!canUseFollowup(profile)) {
      return res.status(403).json({
        error: "Follow-up is available on Pro. Start your 7-day trial to unlock it."
      });
    }

    if (Number(profile.followup_used || 0) >= Number(profile.followup_limit || 0)) {
      return res.status(403).json({
        error: "Monthly follow-up limit reached."
      });
    }

    const {
      notes,
      empresaUsuario,
      leadName,
      leadCompany
    } = req.body || {};

    const config = empresaUsuario || {};
    const meetingNotes = cleanText(notes);

    if (!config.produto) {
      return res.status(400).json({
        error: "Missing user company product/service configuration."
      });
    }

    if (!meetingNotes || meetingNotes.length < 20) {
      return res.status(400).json({
        error: "Meeting notes are too short."
      });
    }

    const companyContext = buildCompanyContext(config);

    const prompt = `
${companyContext}

POST-MEETING CONTEXT:

Lead name:
${cleanText(leadName) || "Lead name not provided"}

Lead company:
${cleanText(leadCompany) || "Lead company not provided"}

Meeting notes or transcript:
${meetingNotes}

TASK:

Generate a practical post-meeting follow-up for a B2B seller.

Rules:
1. Do not sell OctIQ.
2. Help the user company continue the sales process.
3. Be specific to the meeting notes.
4. Do not invent commitments that were not mentioned.
5. If something is unclear, phrase it carefully.
6. Use a professional, direct and human tone.
7. Keep the follow-up email clear and ready to send.
8. Next steps must be concrete.
9. Do not use exaggerated praise.
10. Do not sound like a generic AI assistant.

Return ONLY valid JSON.
Do not include markdown.
Do not include comments.
Do not include explanations outside JSON.

JSON SCHEMA:

{
  "meeting_summary": "",
  "key_pain_points": [
    "",
    "",
    ""
  ],
  "objections_or_risks": [
    "",
    "",
    ""
  ],
  "next_steps": [
    "",
    "",
    ""
  ],
  "follow_up_email": {
    "subject": "",
    "body": ""
  },
  "short_message": "",
  "crm_note": ""
}
`;

    const aiText = await callGroq(prompt);
    const parsed = safeJsonParseFromAI(aiText);

    const followup = {
      meeting_summary: cleanText(parsed.meeting_summary),
      key_pain_points: normalizeQuestions(parsed.key_pain_points),
      objections_or_risks: normalizeQuestions(parsed.objections_or_risks),
      next_steps: normalizeQuestions(parsed.next_steps),
      follow_up_email: {
        subject: cleanText(parsed.follow_up_email?.subject),
        body: cleanText(parsed.follow_up_email?.body)
      },
      short_message: cleanText(parsed.short_message),
      crm_note: cleanText(parsed.crm_note)
    };

    await incrementUsage(profile, "followup");

    await logUsage(profile, {
      action: "followup",
      lead_name: leadName || null,
      lead_role: null
    });

    res.json(followup);
  } catch (err) {
    console.error("FOLLOWUP ERROR:", err.response?.data || err.message);

    res.status(err.status || 500).json({
      error: err.message || "Error generating follow-up",
      details:
        process.env.NODE_ENV === "production"
          ? undefined
          : err.response?.data || err.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found"
  });
});

app.listen(PORT, () => {
  console.log(`🚀 OctIQ API running on port ${PORT}`);
});