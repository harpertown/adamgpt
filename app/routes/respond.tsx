import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/respond";
import type { ConversationSummary, OperatorState, SocketEnvelope } from "../lib/chat";

export function meta({}: Route.MetaArgs) {
	return [
		{ title: "Response Console | AdamGPT" },
		{ name: "description", content: "AdamGPT response console." },
	];
}

export default function Respond() {
	const [state, setState] = useState<OperatorState>({ conversations: [], queuedCount: 0 });
	const [activeId, setActiveId] = useState("");
	const [draft, setDraft] = useState("");
	const [token, setToken] = useState("");
	const [authFailed, setAuthFailed] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");

	useEffect(() => {
		setToken(window.localStorage.getItem("adamgpt-admin-token") ?? "");
	}, []);

	useEffect(() => {
		const queued = state.conversations.find((conversation) => conversation.status === "queued");
		if (!activeId && queued) {
			setActiveId(queued.id);
		}
		if (activeId && !state.conversations.some((conversation) => conversation.id === activeId)) {
			setActiveId(state.conversations[0]?.id ?? "");
		}
	}, [activeId, state.conversations]);

	useEffect(() => {
		window.localStorage.setItem("adamgpt-admin-token", token);
	}, [token]);

	useEffect(() => {
		let closed = false;
		let retry: number | undefined;

		const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
		void fetch("/api/state?role=operator", { headers })
			.then((response) => {
				if (response.status === 401) {
					setAuthFailed(true);
					throw new Error("Unauthorized");
				}
				setAuthFailed(false);
				return response.json() as Promise<OperatorState>;
			})
			.then((nextState) => setState(nextState))
			.catch(() => setConnection("offline"));

		const connect = () => {
			setConnection("connecting");
			const protocol = window.location.protocol === "https:" ? "wss" : "ws";
			const params = new URLSearchParams({ role: "operator" });
			if (token) {
				params.set("token", token);
			}
			const socket = new WebSocket(`${protocol}://${window.location.host}/ws?${params.toString()}`);

			socket.onopen = () => {
				setAuthFailed(false);
				setConnection("live");
			};
			socket.onmessage = (event) => {
				const envelope = JSON.parse(event.data) as SocketEnvelope;
				if (envelope.type === "operator_state") {
					setState(envelope.state);
				}
			};
			socket.onclose = () => {
				if (!closed) {
					setConnection("offline");
					retry = window.setTimeout(connect, 1400);
				}
			};
			socket.onerror = () => socket.close();
		};

		connect();

		return () => {
			closed = true;
			window.clearTimeout(retry);
		};
	}, [token]);

	const activeConversation = useMemo(
		() => state.conversations.find((conversation) => conversation.id === activeId) ?? state.conversations[0] ?? null,
		[activeId, state.conversations],
	);

	async function sendResponse() {
		if (!activeConversation || !draft.trim() || isSending) {
			return;
		}

		setIsSending(true);

		try {
			const response = await fetch("/api/responses", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({ conversationId: activeConversation.id, text: draft.trim() }),
			});

			if (response.status === 401) {
				setAuthFailed(true);
				throw new Error("Unauthorized");
			}
			if (!response.ok) {
				throw new Error("Response failed");
			}

			setAuthFailed(false);
			setDraft("");
			setState((await response.json()) as OperatorState);
		} finally {
			setIsSending(false);
		}
	}

	return (
		<main className="min-h-screen bg-[#f3f6f4] text-[#161817]">
			<section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
				<header className="flex flex-col gap-4 border-b border-[#d6ddd7] py-4 md:flex-row md:items-center md:justify-between">
					<a className="flex items-center gap-3" href="/respond">
						<span className="grid size-10 place-items-center rounded-full bg-[#171717] text-sm font-semibold text-white">
							AG
						</span>
						<span>
							<span className="block text-lg font-semibold tracking-normal">Response Console</span>
							<span className="block text-sm text-[#5f6861]">{state.queuedCount} queued</span>
						</span>
					</a>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
						<label className="flex items-center gap-2 rounded-lg border border-[#cbd5ce] bg-white px-3 py-2">
							<span className="text-sm text-[#5f6861]">Token</span>
							<input
								className="w-40 bg-transparent text-sm outline-none placeholder:text-[#8a958d]"
								onChange={(event) => setToken(event.target.value)}
								placeholder="Optional"
								type="password"
								value={token}
							/>
						</label>
						<div className="flex items-center gap-2 rounded-full border border-[#cbd5ce] bg-white px-3 py-2 text-sm text-[#4d5650]">
							<span
								className={`size-2 rounded-full ${
									connection === "live" ? "bg-[#1f8a5b]" : connection === "connecting" ? "bg-[#b68423]" : "bg-[#b94242]"
								}`}
							/>
							{authFailed ? "Locked" : connection === "live" ? "Live" : connection === "connecting" ? "Connecting" : "Offline"}
						</div>
					</div>
				</header>

				<div className="grid flex-1 gap-5 py-5 lg:grid-cols-[360px_minmax(0,1fr)]">
					<QueueList
						activeId={activeConversation?.id ?? ""}
						conversations={state.conversations}
						onSelect={setActiveId}
					/>
					<ConversationPane
						conversation={activeConversation}
						draft={draft}
						isSending={isSending}
						onDraftChange={setDraft}
						onSend={() => void sendResponse()}
					/>
				</div>
			</section>
		</main>
	);
}

function QueueList({
	activeId,
	conversations,
	onSelect,
}: {
	activeId: string;
	conversations: ConversationSummary[];
	onSelect: (id: string) => void;
}) {
	return (
		<aside className="overflow-hidden rounded-lg border border-[#cbd5ce] bg-white shadow-sm">
			<div className="border-b border-[#dbe2dd] px-4 py-3">
				<h1 className="text-sm font-semibold uppercase tracking-[0.18em] text-[#617067]">Inbox</h1>
			</div>
			<div className="max-h-[calc(100vh-166px)] overflow-y-auto">
				{conversations.length === 0 ? (
					<div className="px-4 py-12 text-center text-sm text-[#6b746e]">No conversations yet.</div>
				) : (
					conversations.map((conversation) => (
						<button
							className={`block w-full border-b border-[#edf0ed] px-4 py-4 text-left transition hover:bg-[#f5f8f6] ${
								activeId === conversation.id ? "bg-[#edf4ef]" : "bg-white"
							}`}
							key={conversation.id}
							onClick={() => onSelect(conversation.id)}
							type="button"
						>
							<div className="mb-2 flex items-center justify-between gap-3">
								<span className="truncate text-sm font-semibold text-[#202522]">
									Visitor {conversation.clientId.slice(0, 8)}
								</span>
								<span
									className={`rounded-full px-2 py-1 text-xs font-medium ${
										conversation.status === "queued"
											? "bg-[#f7e7c6] text-[#75531a]"
											: "bg-[#dff0e7] text-[#236040]"
									}`}
								>
									{conversation.status}
								</span>
							</div>
							<p className="line-clamp-2 text-sm leading-6 text-[#5f6861]">{conversation.lastMessage}</p>
						</button>
					))
				)}
			</div>
		</aside>
	);
}

function ConversationPane({
	conversation,
	draft,
	isSending,
	onDraftChange,
	onSend,
}: {
	conversation: ConversationSummary | null;
	draft: string;
	isSending: boolean;
	onDraftChange: (draft: string) => void;
	onSend: () => void;
}) {
	if (!conversation) {
		return (
			<section className="grid min-h-[calc(100vh-166px)] place-items-center rounded-lg border border-[#cbd5ce] bg-white text-center shadow-sm">
				<div>
					<div className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-[#171717] text-base font-semibold text-white">
						AG
					</div>
					<p className="text-sm text-[#68726b]">The queue is clear.</p>
				</div>
			</section>
		);
	}

	return (
		<section className="flex min-h-[calc(100vh-166px)] flex-col overflow-hidden rounded-lg border border-[#cbd5ce] bg-[#fbfcfb] shadow-sm">
			<div className="flex items-center justify-between border-b border-[#dbe2dd] bg-white px-5 py-4">
				<div>
					<h2 className="text-base font-semibold text-[#202522]">Visitor {conversation.clientId.slice(0, 8)}</h2>
					<p className="text-sm text-[#68726b]">{new Date(conversation.updatedAt).toLocaleString()}</p>
				</div>
				<span
					className={`rounded-full px-3 py-1 text-sm font-medium ${
						conversation.status === "queued" ? "bg-[#f7e7c6] text-[#75531a]" : "bg-[#dff0e7] text-[#236040]"
					}`}
				>
					{conversation.status}
				</span>
			</div>

			<div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
				{conversation.messages.map((message) => (
					<article className={`flex ${message.sender === "user" ? "justify-start" : "justify-end"}`} key={message.id}>
						<div
							className={`max-w-[82%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm ${
								message.sender === "user"
									? "border border-[#dbe2dd] bg-white text-[#202522]"
									: "bg-[#263d63] text-white"
							}`}
						>
							{message.imageId && (
								<img
									alt="Attached image"
									className="mb-2 max-h-48 rounded"
									loading="lazy"
									src={`/api/images/${message.imageId}`}
								/>
							)}
							{message.text}
						</div>
					</article>
				))}
			</div>

			<form
				className="border-t border-[#dbe2dd] bg-white p-4"
				onSubmit={(event) => {
					event.preventDefault();
					onSend();
				}}
			>
				<textarea
					className="min-h-28 w-full resize-none rounded-lg border border-[#cbd5ce] bg-[#fbfcfb] px-4 py-3 text-base leading-6 outline-none transition placeholder:text-[#8a958d] focus:border-[#263d63] focus:ring-2 focus:ring-[#263d63]/15"
					onChange={(event) => onDraftChange(event.target.value)}
					placeholder="Write the answer"
					value={draft}
				/>
				<div className="mt-3 flex justify-end">
					<button
						className="rounded-lg bg-[#171717] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#2d2c29] disabled:cursor-not-allowed disabled:bg-[#a6ada8]"
						disabled={!draft.trim() || isSending}
						type="submit"
					>
						Send answer
					</button>
				</div>
			</form>
		</section>
	);
}
