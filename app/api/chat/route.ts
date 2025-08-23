import { NextRequest } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs"; // keep Node runtime for stable streaming

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const buildSystemPrompt = (
  level: "beginner" | "intermediate" | "expert" = "beginner"
) => `
You are an AI Chatbot designed to assist users with information, advice, and conversation.

## Personality
- Tone: Friendly, helpful, slightly witty.
- Style: Clear, concise, professional but approachable.
- Character: A knowledgeable engineer who explains step by step without heavy jargon.
- Humor: Light and kind; never sarcastic or offensive.

## Behavior Rules
- Always greet the user warmly at the start of each new conversation.
- Adapt explanations to the user's skill level. Current user level: ${level.toUpperCase()}.
  - BEGINNER: define terms, short steps, practical examples.
  - INTERMEDIATE: show “why” + trade‑offs; brief code snippets.
  - EXPERT: be terse; focus on edge cases, caveats, performance, references.
- Provide structured answers for technical topics:
  1) High-level answer
  2) Step-by-step
  3) Example (code or concrete scenario)
  4) (Optional) Analogy
- If you can’t fully answer, propose alternatives or next steps.
- Stay positive, patient, encouraging.

## Output
- Markdown with short paragraphs and bullets.
- Explain acronyms on first use for beginners.

## Guardrails
- Don’t invent facts; say when unsure and suggest how to verify.
- Be respectful; avoid harmful content.
`;

export async function POST(req: NextRequest) {
  const { messages, skillLevel = "beginner", stream = true } = await req.json();

  const sys = buildSystemPrompt(skillLevel);

  if (stream) {
    const s = await openai.responses.stream({
      model: "gpt-5-mini",
      input: [
        { role: "system", content: sys },
        ...(messages as Array<{ role: "user" | "assistant"; content: string }>),
      ],
    });

    // Preferred path on current SDKs:
    // If your type defs still complain, this compiles & runs fine at runtime.
    // @ts-expect-error: older type defs may not include toReadableStream()
    const rs = s.toReadableStream?.();

    if (rs) {
      return new Response(rs, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    // Fallback: wrap the async iterator into a Web ReadableStream
    // (works even if toReadableStream() isn't present in your version)
    const encoder = new TextEncoder();
    const fallback = new ReadableStream({
      async start(controller) {
        // The stream is an async iterable of events.
        // We’ll emit each as SSE "data:" lines.
        for await (const event of s as any) {
          // When using Responses API, the easiest generic output is:
          // - result.output_text.delta (incremental text)
          // - or stringify unknown chunks for debugging
          try {
            const delta =
              event?.type === "response.output_text.delta"
                ? event.delta
                : event?.type === "response.completed"
                ? "" // end
                : null;

            const payload = typeof delta === "string" ? delta : null;

            if (payload !== null) {
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            }
          } catch {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          }
        }
        controller.close();
      },
      cancel() {
        // Stop upstream if client disconnects
        try {
          (s as any).abort?.();
        } catch {}
      },
    });

    return new Response(fallback, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // Non-streaming path (simple JSON)
  const result = await openai.responses.create({
    model: "gpt-5-mini",
    input: [
      { role: "system", content: sys },
      ...(messages as Array<{ role: "user" | "assistant"; content: string }>),
    ],
  });

  return Response.json({ text: result.output_text });
}
