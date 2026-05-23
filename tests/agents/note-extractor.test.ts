import { mock, describe, test, expect, beforeEach } from "bun:test";
import "../setup";
import { zaiClient } from "../../src/services/ai/clients";
import { extractNote } from "../../src/agents/note-extractor";

describe("extractNote", () => {
  beforeEach(() => {
    const client = zaiClient();
    (client as any).chat.completions.create = async (_params: any, _options: any) => {
      return {
        [Symbol.asyncIterator]: async function* () {
          yield {
            choices: [
              {
                delta: {
                  content: JSON.stringify({
                    title: "Team sync notes",
                    summary: "Discussed project timeline and assigned tasks.",
                    keyPoints: ["Timeline moved to Q3", "Budget approved"],
                    decisions: ["Use React for frontend"],
                    actionItems: [
                      { task: "Prepare wireframes", owner: "Alice", deadline: "Friday" },
                    ],
                    tags: ["Meeting", "Technical"],
                  }),
                },
              },
            ],
          };
        },
      };
    };
  });

  test("extracts structured note from messages", async () => {
    const result = await extractNote([
      { userId: 1, userName: "Alice", content: "Let's move timeline to Q3" },
      { userId: 2, userName: "Bob", content: "Budget approved by CFO" },
      { userId: 1, userName: "Alice", content: "I'll prepare wireframes by Friday" },
    ]);

    expect(result.title).toBe("Team sync notes");
    expect(result.summary).toContain("timeline");
    expect(result.keyPoints.length).toBeGreaterThan(0);
    expect(result.actionItems.length).toBeGreaterThan(0);
    expect(result.tags.length).toBeGreaterThan(0);
  });

  test("parses JSON wrapped in markdown fences", async () => {
    const client = zaiClient();
    (client as any).chat.completions.create = async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [
            {
              delta: {
                content:
                  '```json\n{"title":"Test","summary":"ok","keyPoints":[],"decisions":[],"actionItems":[],"tags":[]}\n```',
              },
            },
          ],
        };
      },
    });

    const result = await extractNote([{ userId: 1, userName: "User", content: "Hello" }]);
    expect(result.title).toBe("Test");
  });

  test("falls back gracefully on invalid JSON", async () => {
    const client = zaiClient();
    (client as any).chat.completions.create = async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [{ delta: { content: "This is not JSON at all" } }],
        };
      },
    });

    const result = await extractNote([{ userId: 1, userName: "User", content: "Hello" }]);
    expect(result.title).toBe("Заметка из чата");
    expect(result.summary).toContain("not JSON");
  });
});
