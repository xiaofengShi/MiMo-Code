import { describe, expect, test } from "bun:test"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { normalizeToolResult } from "../../src/mcp/tool-result"

function parseResult(result: CallToolResult) {
  return CallToolResultSchema.parse(result)
}

describe("MCP tool result normalization", () => {
  test("preserves standard fields and classifies tool execution errors", () => {
    const result: CallToolResult = {
      content: [
        { type: "text", text: "Message was not sent" },
        { type: "image", data: "Zm9v", mimeType: "image/png" },
      ],
      structuredContent: { sent: false, reason: "composer rejected the request" },
      isError: true,
      _meta: { traceId: "private-trace-id" },
    }

    const received = parseResult(result)
    const normalized = normalizeToolResult(received)

    expect(received).toEqual(result)
    expect(normalized.isError).toBe(true)
    expect(normalized.content).toEqual(result.content)
    expect(normalized.output).toBe(
      'Message was not sent\n\nStructured content:\n{"sent":false,"reason":"composer rejected the request"}',
    )
    expect(normalized.attachments).toEqual([
      {
        mime: "image/png",
        url: "data:image/png;base64,Zm9v",
      },
    ])
    expect(normalized.metadata.mcp).toEqual({
      structuredContent: result.structuredContent,
      isError: true,
      _meta: result._meta,
    })
    expect(normalized.output).not.toContain("private-trace-id")
  })

  test("uses structured content as a fallback without exposing _meta", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "   " }],
      structuredContent: { changed: true, windowID: 42 },
      _meta: { privateToken: "do-not-send-to-model" },
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.isError).toBe(false)
    expect(normalized.output).toBe('{"changed":true,"windowID":42}')
    expect(normalized.output).not.toContain("do-not-send-to-model")
    expect(normalized.metadata.mcp).toEqual({
      structuredContent: result.structuredContent,
      isError: false,
      _meta: result._meta,
    })
  })

  test("converts inline media and resource links while retaining raw content", () => {
    const result: CallToolResult = {
      content: [
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        { type: "resource_link", uri: "file:///tmp/report.txt", name: "report" },
      ],
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.output).toBe("report: file:///tmp/report.txt")
    expect(normalized.attachments).toEqual([
      {
        mime: "audio/wav",
        url: "data:audio/wav;base64,YXVkaW8=",
      },
    ])
    expect(normalized.content).toEqual(result.content)
  })

  test("does not duplicate structured content already serialized by the server", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: 'Result:\n{\n  "changed": true\n}' }],
      structuredContent: { changed: true },
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.output).toBe('Result:\n{\n  "changed": true\n}')
  })
})
