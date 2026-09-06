import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/respond";
import type { ConversationSummary, OperatorState, SocketEnvelope } from "../lib/chat";

export function meta({}: Route.MetaArgs) {
	return [
		{ title: "Response Console | AdamGPT" },
		{ name: "description", content: "AdamGPT response console." },
	];
}

const CONSOLE_PASSWORD = "qwerty2712";

export default function Respond() {
	const [unlocked, setUnlocked] = useState(() => {
		if (typeof window !== "undefined") {
			return window.sessionStorage.getItem("adamgpt-unlocked") === "1";
		}
		return false;
	});
	const [passwordInput, setPasswordInput] = useState("");
	const [passwordError, setPasswordError] = useState(false);

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

	function authHeaders(): Record<string, string> {
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

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
					...authHeaders(),
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

	async function deleteConversation(conversationId: string) {
		try {
			const response = await fetch("/api/conversations", {
				method: "DELETE",
				headers: {
					"Content-Type": "application/json",
					...authHeaders(),
				},
				body: JSON.stringify({ conversationId }),
			});

			if (response.status === 401) {
				setAuthFailed(true);
				return;
			}
			if (!response.ok) {
				return;
			}

			setAuthFailed(false);
			setDraft("");
			setState((await response.json()) as OperatorState);
		} catch {
			// ignore
		}
	}

	if (!unlocked) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-[#f3f6f4] text-[#161817]">
				<form
					className="w-full max-w-sm rounded-lg border border-[#cbd5ce] bg-white p-8 shadow-sm"
					onSubmit={(event) => {
						event.preventDefault();
						if (passwordInput === CONSOLE_PASSWORD) {
							window.sessionStorage.setItem("adamgpt-unlocked", "1");
							setUnlocked(true);
							setPasswordError(false);
						} else {
							setPasswordError(true);
						}
					}}
				>
					<div className="mb-6 flex justify-center">
						<span className="grid size-12 place-items-center rounded-full bg-[#171717] text-sm font-semibold text-white">
							AG
						</span>
					</div>
					<h1 className="mb-1 text-center text-lg font-semibold">Response Console</h1>
					<p className="mb-6 text-center text-sm text-[#5f6861]">Enter password to continue</p>
					<input
						autoFocus
						className={`w-full rounded-lg border px-4 py-3 text-sm outline-none transition placeholder:text-[#8a958d] focus:ring-2 focus:ring-[#263d63]/15 ${
							passwordError ? "border-[#b94242] focus:border-[#b94242]" : "border-[#cbd5ce] focus:border-[#263d63]"
						}`}
						onChange={(event) => {
							setPasswordInput(event.target.value);
							setPasswordError(false);
						}}
						placeholder="Password"
						type="password"
						value={passwordInput}
					/>
					{passwordError && <p className="mt-2 text-sm text-[#b94242]">Incorrect password</p>}
					<button
						className="mt-4 w-full rounded-lg bg-[#171717] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#2d2c29]"
						type="submit"
					>
						Unlock
					</button>
				</form>
			</main>
		);
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
						onDelete={deleteConversation}
						onSelect={setActiveId}
					/>
					<ConversationPane
						conversation={activeConversation}
						draft={draft}
						isSending={isSending}
						onDelete={() => activeConversation && deleteConversation(activeConversation.id)}
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
	onDelete,
	onSelect,
}: {
	activeId: string;
	conversations: ConversationSummary[];
	onDelete: (id: string) => void;
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
						<div
							className={`group relative border-b border-[#edf0ed] transition hover:bg-[#f5f8f6] ${
								activeId === conversation.id ? "bg-[#edf4ef]" : "bg-white"
							}`}
							key={conversation.id}
						>
							<button
								className="block w-full px-4 py-4 text-left"
								onClick={() => onSelect(conversation.id)}
								type="button"
							>
								<div className="mb-2 flex items-center justify-between gap-3">
									<span className="truncate text-sm font-semibold text-[#202522]">
										{conversation.displayName || `Visitor ${conversation.clientId.slice(0, 8)}`}
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
							<button
								className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-[#a3b0a7] opacity-0 transition hover:bg-[#e8ebe9] hover:text-[#b94242] group-hover:opacity-100"
								onClick={(e) => {
									e.stopPropagation();
									onDelete(conversation.id);
								}}
								title="Delete conversation"
								type="button"
							>
								<svg className="size-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} viewBox="0 0 24 24">
									<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14" />
								</svg>
							</button>
						</div>
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
	onDelete,
	onDraftChange,
	onSend,
}: {
	conversation: ConversationSummary | null;
	draft: string;
	isSending: boolean;
	onDelete: () => void;
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
					<h2 className="text-base font-semibold text-[#202522]">{conversation.displayName || `Visitor ${conversation.clientId.slice(0, 8)}`}</h2>
					<p className="text-sm text-[#68726b]">{new Date(conversation.updatedAt).toLocaleString()}</p>
				</div>
				<div className="flex items-center gap-3">
					<span
						className={`rounded-full px-3 py-1 text-sm font-medium ${
							conversation.status === "queued" ? "bg-[#f7e7c6] text-[#75531a]" : "bg-[#dff0e7] text-[#236040]"
						}`}
					>
						{conversation.status}
					</span>
					<button
						className="grid size-9 place-items-center rounded-lg border border-[#dbe2dd] text-[#8a958d] transition hover:border-[#b94242] hover:bg-[#fef2f2] hover:text-[#b94242]"
						onClick={onDelete}
						title="Delete conversation"
						type="button"
					>
						<svg className="size-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} viewBox="0 0 24 24">
							<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14" />
						</svg>
					</button>
				</div>
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
							{message.fileId && (
								<a
									className="mb-2 flex items-center gap-2 rounded border border-[#cbd5ce] bg-[#f3f6f4] px-3 py-2 text-sm text-[#4d5650] transition hover:bg-[#e8ebe9]"
									download
									href={`/api/files/${message.fileId}`}
								>
									<svg className="size-4 shrink-0" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} viewBox="0 0 24 24">
										<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
										<polyline points="14 2 14 8 20 8" />
									</svg>
									Download file
								</a>
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
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							onSend();
						}
					}}
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
