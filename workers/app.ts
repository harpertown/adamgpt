import { DurableObject } from "cloudflare:workers";
import { createRequestHandler } from "react-router";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: AppEnv;
			ctx: ExecutionContext;
		};
	}
}

type AppEnv = Env & {
	CHAT_QUEUE: DurableObjectNamespace<ChatQueue>;
	ADMIN_TOKEN?: string;
};

type Sender = "user" | "assistant";
type ConversationStatus = "queued" | "answered";

type ChatMessage = {
	id: string;
	conversationId: string;
	sender: Sender;
	text: string;
	imageId?: string;
	createdAt: number;
};

type ConversationSummary = {
	id: string;
	clientId: string;
	displayName: string;
	status: ConversationStatus;
	createdAt: number;
	updatedAt: number;
	lastMessage: string;
	messages: ChatMessage[];
};

type PublicState = {
	conversation: ConversationSummary | null;
};

type OperatorState = {
	conversations: ConversationSummary[];
	queuedCount: number;
};

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

export class ChatQueue extends DurableObject<AppEnv> {
	private initialized: Promise<void>;

	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
		this.initialized = this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS conversations (
					id TEXT PRIMARY KEY,
					client_id TEXT NOT NULL UNIQUE,
					status TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				)
			`);
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS messages (
					id TEXT PRIMARY KEY,
					conversation_id TEXT NOT NULL,
					sender TEXT NOT NULL,
					text TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`);
			try {
				this.ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN image_id TEXT");
			} catch {
				// column already exists
			}
			try {
				this.ctx.storage.sql.exec("ALTER TABLE conversations ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
			} catch {
				// column already exists
			}
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS images (
					id TEXT PRIMARY KEY,
					content_type TEXT NOT NULL,
					data BLOB NOT NULL,
					created_at INTEGER NOT NULL
				)
			`);
			this.ctx.storage.sql.exec(
				"CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at)",
			);
			this.ctx.storage.sql.exec(
				"CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at)",
			);
		});
	}

	async fetch(request: Request): Promise<Response> {
		await this.initialized;

		if (request.headers.get("Upgrade") !== "websocket") {
			return json({ error: "Expected a WebSocket upgrade." }, 426);
		}

		const url = new URL(request.url);
		const role = url.searchParams.get("role") === "operator" ? "operator" : "user";
		const clientId = cleanId(url.searchParams.get("clientId"));

		if (role === "operator" && !isAuthorized(request, this.env)) {
			return json({ error: "Unauthorized." }, 401);
		}

		if (role === "user" && !clientId) {
			return json({ error: "Missing clientId." }, 400);
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const tags = role === "operator" ? ["operator"] : [`client:${clientId}`];

		server.serializeAttachment({ role, clientId });
		this.ctx.acceptWebSocket(server, tags);

		const state =
			role === "operator"
				? { type: "operator_state", state: this.getOperatorState() }
				: { type: "public_state", state: this.getPublicState(clientId) };
		server.send(JSON.stringify(state));

		return new Response(null, { status: 101, webSocket: client });
	}

	async storeImage(data: ArrayBuffer, contentType: string): Promise<string> {
		await this.initialized;
		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			"INSERT INTO images (id, content_type, data, created_at) VALUES (?, ?, ?, ?)",
			id,
			contentType,
			data,
			Date.now(),
		);
		return id;
	}

	async getImage(id: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
		await this.initialized;
		const row = this.ctx.storage.sql
			.exec<{ data: ArrayBuffer; content_type: string }>(
				"SELECT data, content_type FROM images WHERE id = ? LIMIT 1",
				cleanId(id),
			)
			.toArray()[0];
		return row ? { data: row.data, contentType: row.content_type } : null;
	}

	async submitMessage(clientId: string, text: string, imageId?: string, displayName?: string): Promise<PublicState> {
		await this.initialized;

		const safeClientId = cleanId(clientId);
		const safeText = cleanText(text);
		const safeImageId = imageId ? cleanId(imageId) : null;
		const safeName = cleanText(displayName).slice(0, 50);

		if (!safeClientId) {
			throw new Response("Missing clientId.", { status: 400 });
		}
		if (!safeText && !safeImageId) {
			throw new Response("Message cannot be empty.", { status: 400 });
		}

		const now = Date.now();
		let conversation = this.findConversationByClient(safeClientId);

		if (!conversation) {
			conversation = {
				id: crypto.randomUUID(),
				clientId: safeClientId,
				displayName: safeName,
				status: "queued",
				createdAt: now,
				updatedAt: now,
				lastMessage: "",
				messages: [],
			};
			this.ctx.storage.sql.exec(
				"INSERT INTO conversations (id, client_id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				conversation.id,
				conversation.clientId,
				conversation.displayName,
				conversation.status,
				conversation.createdAt,
				conversation.updatedAt,
			);
		} else {
			if (safeName && safeName !== conversation.displayName) {
				this.ctx.storage.sql.exec(
					"UPDATE conversations SET display_name = ? WHERE id = ?",
					safeName,
					conversation.id,
				);
			}
			this.ctx.storage.sql.exec(
				"UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?",
				"queued",
				now,
				conversation.id,
			);
		}

		this.ctx.storage.sql.exec(
			"INSERT INTO messages (id, conversation_id, sender, text, image_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			crypto.randomUUID(),
			conversation.id,
			"user",
			safeText,
			safeImageId,
			now,
		);

		const publicState = this.getPublicState(safeClientId);
		this.broadcastToOperators();
		this.broadcastToClient(safeClientId, publicState);
		return publicState;
	}

	async submitResponse(conversationId: string, text: string, token: string): Promise<OperatorState> {
		await this.initialized;

		if (!isAuthorizedToken(token, this.env)) {
			throw new Response("Unauthorized.", { status: 401 });
		}

		const safeConversationId = cleanId(conversationId);
		const safeText = cleanText(text);

		if (!safeConversationId) {
			throw new Response("Missing conversationId.", { status: 400 });
		}
		if (!safeText) {
			throw new Response("Response cannot be empty.", { status: 400 });
		}

		const conversation = this.findConversationById(safeConversationId);
		if (!conversation) {
			throw new Response("Conversation not found.", { status: 404 });
		}

		const now = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO messages (id, conversation_id, sender, text, created_at) VALUES (?, ?, ?, ?, ?)",
			crypto.randomUUID(),
			conversation.id,
			"assistant",
			safeText,
			now,
		);
		this.ctx.storage.sql.exec(
			"UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?",
			"answered",
			now,
			conversation.id,
		);

		const operatorState = this.getOperatorState();
		this.broadcastToOperators(operatorState);
		this.broadcastToClient(conversation.clientId, this.getPublicState(conversation.clientId));
		return operatorState;
	}

	async deleteConversation(conversationId: string, token: string): Promise<OperatorState> {
		await this.initialized;

		if (!isAuthorizedToken(token, this.env)) {
			throw new Response("Unauthorized.", { status: 401 });
		}

		const safeId = cleanId(conversationId);
		if (!safeId) {
			throw new Response("Missing conversationId.", { status: 400 });
		}

		const conversation = this.findConversationById(safeId);
		if (!conversation) {
			throw new Response("Conversation not found.", { status: 404 });
		}

		this.ctx.storage.sql.exec("DELETE FROM messages WHERE conversation_id = ?", safeId);
		this.ctx.storage.sql.exec("DELETE FROM conversations WHERE id = ?", safeId);

		const deleted = JSON.stringify({ type: "conversation_deleted" });
		for (const socket of this.ctx.getWebSockets(`client:${conversation.clientId}`)) {
			socket.send(deleted);
		}

		const operatorState = this.getOperatorState();
		this.broadcastToOperators(operatorState);
		return operatorState;
	}

	async getPublicStateFor(clientId: string): Promise<PublicState> {
		await this.initialized;
		return this.getPublicState(cleanId(clientId));
	}

	async getOperatorStateFor(token: string): Promise<OperatorState> {
		await this.initialized;
		if (!isAuthorizedToken(token, this.env)) {
			throw new Response("Unauthorized.", { status: 401 });
		}
		return this.getOperatorState();
	}

	private getPublicState(clientId: string): PublicState {
		const conversation = this.findConversationByClient(clientId);
		return { conversation };
	}

	private getOperatorState(): OperatorState {
		const conversations = this.ctx.storage.sql
			.exec<ConversationRow>(
				"SELECT id, client_id, display_name, status, created_at, updated_at FROM conversations ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, CASE WHEN status = 'queued' THEN created_at END ASC, CASE WHEN status != 'queued' THEN updated_at END DESC LIMIT 100",
			)
			.toArray()
			.map((row) => this.hydrateConversation(row));

		return {
			conversations,
			queuedCount: conversations.filter((conversation) => conversation.status === "queued").length,
		};
	}

	private findConversationByClient(clientId: string): ConversationSummary | null {
		const row = this.ctx.storage.sql
			.exec<ConversationRow>(
				"SELECT id, client_id, display_name, status, created_at, updated_at FROM conversations WHERE client_id = ? LIMIT 1",
				clientId,
			)
			.toArray()[0];
		return row ? this.hydrateConversation(row) : null;
	}

	private findConversationById(conversationId: string): ConversationSummary | null {
		const row = this.ctx.storage.sql
			.exec<ConversationRow>(
				"SELECT id, client_id, display_name, status, created_at, updated_at FROM conversations WHERE id = ? LIMIT 1",
				conversationId,
			)
			.toArray()[0];
		return row ? this.hydrateConversation(row) : null;
	}

	private hydrateConversation(row: ConversationRow): ConversationSummary {
		const messages = this.ctx.storage.sql
			.exec<MessageRow>(
				"SELECT id, conversation_id, sender, text, image_id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200",
				row.id,
			)
			.toArray()
			.map((message) => ({
				id: message.id,
				conversationId: message.conversation_id,
				sender: (message.sender === "assistant" ? "assistant" : "user") as Sender,
				text: message.text,
				...(message.image_id ? { imageId: message.image_id } : {}),
				createdAt: message.created_at,
			}));
		const lastMessage = messages.at(-1)?.text ?? "";

		return {
			id: row.id,
			clientId: row.client_id,
			displayName: row.display_name || "",
			status: row.status === "answered" ? "answered" : "queued",
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			lastMessage,
			messages,
		};
	}

	private broadcastToOperators(state = this.getOperatorState()) {
		const message = JSON.stringify({ type: "operator_state", state });
		for (const socket of this.ctx.getWebSockets("operator")) {
			socket.send(message);
		}
	}

	private broadcastToClient(clientId: string, state = this.getPublicState(clientId)) {
		const message = JSON.stringify({ type: "public_state", state });
		for (const socket of this.ctx.getWebSockets(`client:${clientId}`)) {
			socket.send(message);
		}
	}
}

type ConversationRow = {
	id: string;
	client_id: string;
	display_name: string;
	status: string;
	created_at: number;
	updated_at: number;
};

type MessageRow = {
	id: string;
	conversation_id: string;
	sender: string;
	text: string;
	image_id: string | null;
	created_at: number;
};

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/ws") {
			return getChatQueue(env).fetch(request);
		}

		if (url.pathname === "/api/upload" && request.method === "POST") {
			try {
				const contentType = request.headers.get("Content-Type") ?? "";
				if (!contentType.startsWith("image/")) {
					return json({ error: "Only image uploads are allowed." }, 400);
				}
				const data = await request.arrayBuffer();
				if (data.byteLength > 5 * 1024 * 1024) {
					return json({ error: "Image must be under 5MB." }, 400);
				}
				const imageId = await getChatQueue(env).storeImage(data, contentType);
				return json({ imageId });
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
			try {
				const imageId = url.pathname.slice("/api/images/".length);
				const image = await getChatQueue(env).getImage(imageId);
				if (!image) {
					return json({ error: "Image not found." }, 404);
				}
				return new Response(image.data, {
					headers: {
						"Content-Type": image.contentType,
						"Cache-Control": "public, max-age=31536000, immutable",
					},
				});
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (url.pathname === "/api/messages" && request.method === "POST") {
			try {
				const body = await request.json<{ clientId?: string; text?: string; imageId?: string; displayName?: string }>();
				const state = await getChatQueue(env).submitMessage(body.clientId ?? "", body.text ?? "", body.imageId, body.displayName);
				return json(state);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (url.pathname === "/api/responses" && request.method === "POST") {
			try {
				const body = await request.json<{ conversationId?: string; text?: string }>();
				const state = await getChatQueue(env).submitResponse(
					body.conversationId ?? "",
					body.text ?? "",
					extractToken(request),
				);
				return json(state);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (url.pathname === "/api/conversations" && request.method === "DELETE") {
			try {
				const body = await request.json<{ conversationId?: string }>();
				const state = await getChatQueue(env).deleteConversation(
					body.conversationId ?? "",
					extractToken(request),
				);
				return json(state);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (url.pathname === "/api/state" && request.method === "GET") {
			try {
				if (url.searchParams.get("role") === "operator") {
					return json(await getChatQueue(env).getOperatorStateFor(extractToken(request)));
				}

				return json(await getChatQueue(env).getPublicStateFor(url.searchParams.get("clientId") ?? ""));
			} catch (error) {
				return errorResponse(error);
			}
		}

		return requestHandler(request, {
			cloudflare: { env, ctx },
		});
	},
} satisfies ExportedHandler<AppEnv>;

function getChatQueue(env: AppEnv) {
	const id = env.CHAT_QUEUE.idFromName("global");
	return env.CHAT_QUEUE.get(id);
}

function extractToken(request: Request) {
	const authorization = request.headers.get("Authorization");
	const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
	const query = new URL(request.url).searchParams.get("token");
	return bearer || query || "";
}

function isAuthorized(request: Request, env: AppEnv) {
	return isAuthorizedToken(extractToken(request), env);
}

function isAuthorizedToken(token: string, env: AppEnv) {
	if (!env.ADMIN_TOKEN) {
		return true;
	}
	return token === env.ADMIN_TOKEN;
}

function cleanId(value: string | null | undefined) {
	return (value ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function cleanText(value: string | null | undefined) {
	return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

function json(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
		},
	});
}

function errorResponse(error: unknown) {
	if (error instanceof Response) {
		return json({ error: error.statusText || "Request failed." }, error.status);
	}

	return json({ error: error instanceof Error ? error.message : "Request failed." }, 500);
}
