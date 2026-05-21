// Supabase Edge Function: Gemini API Proxy
// Gemini API anahtarı Supabase Secrets'ta güvenle saklanır.
// Client tarafı bu fonksiyonu çağırır, API key hiçbir zaman client'a gönderilmez.
//
// Secret ayarlama:
//   supabase secrets set GEMINI_API_KEY=your-api-key-here

import "https://deno.land/x/xhr@0.1.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface TranslateRequest {
  text: string;
  targetLang: "tr" | "de";
}

interface AnalyzeRequest {
  type: "invoice" | "productivity" | "taskProgress";
  data: Record<string, unknown>;
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY is not configured in secrets" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action, payload } = await req.json();

    let prompt = "";

    if (action === "translate") {
      const { text, targetLang } = payload as TranslateRequest;
      if (!text || !targetLang) {
        return new Response(
          JSON.stringify({ error: "text and targetLang are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      prompt = `Translate the following text to ${targetLang === "de" ? "German" : "Turkish"}. Return only the translated text, do not add any explanations or quotes.\n\nText: "${text}"`;
    } else if (action === "analyze") {
      const { type, data } = payload as AnalyzeRequest;
      if (type === "productivity") {
        const { tasksCompleted, hoursWorked } = data as { tasksCompleted: number; hoursWorked: number };
        prompt = `Analyze employee productivity: ${tasksCompleted} tasks completed in ${hoursWorked} hours. Give a brief Turkish summary (2 sentences max).`;
      } else if (type === "taskProgress") {
        const { pendingCount, highPriorityCount } = data as { pendingCount: number; highPriorityCount: number };
        prompt = `Analyze task progress: ${pendingCount} pending tasks, ${highPriorityCount} high priority. Give a brief Turkish executive summary (3 sentences max).`;
      } else {
        return new Response(
          JSON.stringify({ error: "Unknown analyze type" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      return new Response(
        JSON.stringify({ error: "Unknown action. Use 'translate' or 'analyze'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Gemini API çağrısı
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 256,
        },
      }),
    });

    if (!geminiResponse.ok) {
      const errorBody = await geminiResponse.text();
      return new Response(
        JSON.stringify({ error: "Gemini API error", details: errorBody }),
        { status: geminiResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiData = await geminiResponse.json();
    const resultText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    return new Response(
      JSON.stringify({ result: resultText }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
