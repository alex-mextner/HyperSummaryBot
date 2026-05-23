import { describe, test, expect } from "bun:test";
import { renderTable, markdownTableToHtml } from "../../src/utils/table-renderer";

describe("renderTable", () => {
  test("renders ASCII table inside <pre>", () => {
    const result = renderTable(
      ["Name", "Status"],
      [
        { Name: "Alice", Status: "Done" },
        { Name: "Bob", Status: "In progress" },
      ],
    );
    expect(result).toStartWith("<pre>");
    expect(result).toEndWith("</pre>");
    expect(result).toContain("| Name  | Status      |");
    expect(result).toContain("| Alice | Done        |");
    expect(result).toContain("| Bob   | In progress |");
  });

  test("renders empty rows as italic", () => {
    const result = renderTable(["A", "B"], []);
    expect(result).toBe("<i>(пусто)</i>");
  });

  test("falls back to list for wide tables", () => {
    const longHeader = "VeryLongHeaderNameThatMakesTableWideAndExceedsThreshold";
    const result = renderTable(
      [longHeader, "Value", "Another"],
      [{ [longHeader]: "x", Value: "y", Another: "z" }],
    );
    expect(result).not.toContain("<pre>");
    expect(result).toContain("<b>1.</b>");
    expect(result).toContain("<code>");
  });

  test("handles missing cells gracefully", () => {
    const result = renderTable(["A", "B", "C"], [{ A: "1", B: "2" }]);
    expect(result).toContain("| 1 | 2 |   |");
  });

  test("escapes ampersands in cell values", () => {
    const result = renderTable(["Company", "Field"], [{ Company: "AT&T", Field: "R&D" }]);
    expect(result).toContain("AT&amp;T");
    expect(result).toContain("R&amp;D");
  });
});

describe("markdownTableToHtml", () => {
  test("converts markdown table to <pre> ASCII table", () => {
    const md = `| Name | Role |
|------|------|
| Alice | Admin |
| Bob | User |`;
    const html = markdownTableToHtml(md);
    expect(html).toStartWith("<pre>");
    expect(html).toContain("| Name  | Role  |");
    expect(html).toContain("| Alice | Admin |");
    expect(html).toContain("| Bob   | User  |");
  });

  test("leaves non-table text untouched", () => {
    const text = "Hello world\n\nSome text | with pipes | in it\n\nGoodbye";
    expect(markdownTableToHtml(text)).toBe(text);
  });

  test("handles multiple tables", () => {
    const md = `| A | B |
|---|---|
| 1 | 2 |

Some text

| X | Y |
|---|---|
| 3 | 4 |`;
    const html = markdownTableToHtml(md);
    const preCount = (html.match(/<pre>/g) || []).length;
    expect(preCount).toBe(2);
    expect(html).toContain("| A | B |");
    expect(html).toContain("| X | Y |");
  });
});
