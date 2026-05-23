import { loadConfig } from "../config/env";

const NOTION_API_VERSION = "2022-06-28";

function getHeaders(): Record<string, string> {
  const config = loadConfig();
  return {
    Authorization: `Bearer ${config.NOTION_TOKEN}`,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json",
  };
}

export function isNotionConfigured(): boolean {
  const config = loadConfig();
  return !!config.NOTION_TOKEN;
}

export interface NotionDatabase {
  id: string;
  title: string;
  url?: string;
}

/** Search for databases shared with this integration. */
export async function searchDatabases(): Promise<NotionDatabase[]> {
  const response = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      filter: { value: "database", property: "object" },
      page_size: 100,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Notion search error ${response.status}: ${error}`);
  }

  const data = (await response.json()) as {
    results: Array<{
      id: string;
      title?: Array<{ plain_text: string }>;
      url?: string;
    }>;
  };

  return data.results.map((db) => ({
    id: db.id,
    title: db.title?.[0]?.plain_text ?? "Untitled database",
    url: db.url,
  }));
}

/** Create a new database in a parent page. Returns the new database ID. */
export async function createDatabase(parentPageId: string, title: string): Promise<string> {
  const response = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      properties: {
        Name: { title: {} },
        Tags: { multi_select: { options: [] } },
        Status: {
          select: {
            options: [
              { name: "Draft", color: "yellow" },
              { name: "Published", color: "green" },
              { name: "Archived", color: "gray" },
            ],
          },
        },
        Date: { date: {} },
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Notion create database error ${response.status}: ${error}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

export interface NotionPageInput {
  title: string;
  summary: string;
  keyPoints?: string[];
  actionItems?: Array<{ task: string; owner?: string; deadline?: string }>;
  decisions?: string[];
  tags?: string[];
  url?: string;
}

/** Create a Notion page in a specific database. */
export async function createNotePage(
  databaseId: string,
  input: NotionPageInput,
): Promise<{ url: string; id: string }> {
  const config = loadConfig();
  if (!config.NOTION_TOKEN) {
    throw new Error("Notion not configured. Set NOTION_TOKEN in .env");
  }

  const children: Array<Record<string, unknown>> = [
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Summary" } }],
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: input.summary } }],
      },
    },
  ];

  if (input.keyPoints && input.keyPoints.length > 0) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Key Points" } }],
      },
    });
    for (const point of input.keyPoints) {
      children.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: point } }],
        },
      });
    }
  }

  if (input.decisions && input.decisions.length > 0) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Decisions" } }],
      },
    });
    for (const decision of input.decisions) {
      children.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: decision } }],
        },
      });
    }
  }

  if (input.actionItems && input.actionItems.length > 0) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Action Items" } }],
      },
    });
    for (const item of input.actionItems) {
      const text = item.deadline
        ? `${item.task} — @${item.owner ?? "?"} — до ${item.deadline}`
        : item.owner
          ? `${item.task} — @${item.owner}`
          : item.task;
      children.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ type: "text", text: { content: text } }],
          checked: false,
        },
      });
    }
  }

  if (input.url) {
    children.push({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Source" } }],
      },
    });
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: "Telegram chat link",
              link: { url: input.url },
            },
          },
        ],
      },
    });
  }

  const body = {
    parent: { database_id: databaseId },
    properties: {
      Name: {
        title: [{ type: "text", text: { content: input.title } }],
      },
      ...(input.tags && input.tags.length > 0
        ? {
            Tags: {
              multi_select: input.tags.map((t) => ({ name: t })),
            },
          }
        : {}),
    },
    children,
  };

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Notion API error ${response.status}: ${error}`);
  }

  const data = (await response.json()) as { id: string; url: string };
  return { id: data.id, url: data.url };
}
