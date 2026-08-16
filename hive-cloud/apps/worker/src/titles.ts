import type { Job } from "bullmq";
import { z } from "zod";

interface TitleJobData {
  conversationId: string;
  tenantId: string;
  messageContent: string;
}

export function createTitlesProcessor(apiOrigin: string, serviceSecret: string) {
  return async (job: Job<TitleJobData>) => {
    const { conversationId, tenantId, messageContent } = job.data;
    
    // We want to generate a short title based on the user's first message.
    const systemPrompt = `You are a helpful assistant that generates a short, concise, and descriptive title for a conversation.
The user will provide their first message. Respond ONLY with the title. Do not include quotes, prefixes, or punctuation.
Keep it under 5 words.`;

    const requestBody = {
      model: "hive-0.1",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: messageContent }
      ],
      hive: {
        policy: "free-first-balanced",
      }
    };

    const response = await fetch(`${apiOrigin.replace(/\/$/, "")}/api/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceSecret}`,
        "X-Hive-Tenant": tenantId
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Failed to generate title: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const title = data.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "") || "New conversation";

    // Update the conversation with the new title
    const updateResponse = await fetch(`${apiOrigin.replace(/\/$/, "")}/api/conversations/${conversationId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceSecret}`,
        "X-Hive-Tenant": tenantId
      },
      body: JSON.stringify({ title }),
    });

    if (!updateResponse.ok) {
      throw new Error(`Failed to update conversation title: ${updateResponse.status} ${await updateResponse.text()}`);
    }
  };
}
