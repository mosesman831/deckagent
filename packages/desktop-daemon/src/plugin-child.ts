import { pathToFileURL } from "node:url";
import { z } from "zod";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

const RunMessageSchema = z
  .object({
    type: z.literal("run"),
    entry: z.string().min(1),
    args: JsonValueSchema,
  })
  .strict();

const PluginToolContentSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
  }),
]);

const PluginResponseSchema = z
  .object({
    content: z.array(PluginToolContentSchema),
    isError: z.boolean().optional(),
  })
  .strict();

type RunMessage = z.infer<typeof RunMessageSchema>;

type ChildResultMessage =
  | { type: "result"; result: z.infer<typeof PluginResponseSchema> }
  | { type: "error"; message: string };

type PluginRun = (args: JsonValue) => Promise<unknown>;

function send(message: ChildResultMessage): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

async function runPlugin(message: RunMessage): Promise<void> {
  const mod = (await import(pathToFileURL(message.entry).href)) as {
    run?: unknown;
  };
  if (typeof mod.run !== "function") {
    throw new Error("plugin entry must export async function run(args)");
  }

  const response = await (mod.run as PluginRun)(message.args);
  const parsed = PluginResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(`plugin returned an invalid ToolResponse: ${parsed.error.message}`);
  }
  send({ type: "result", result: parsed.data });
}

process.on("message", (raw: unknown) => {
  const parsed = RunMessageSchema.safeParse(raw);
  if (!parsed.success) {
    send({ type: "error", message: `invalid plugin child message: ${parsed.error.message}` });
    return;
  }

  runPlugin(parsed.data)
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      send({ type: "error", message: humanError(err) });
      process.exit(1);
    });
});

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
