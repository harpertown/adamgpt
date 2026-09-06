import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./+types/home";
import type { PublicState, SocketEnvelope } from "../lib/chat";

const starterPrompts = [
	"Draft a sharper version of this email",
	"Help me think through a product idea",
	"Summarize this messy note",
];

export function meta({}: Route.MetaArgs) {
	return [
		{ title: "AdamGPT" },
		{ name: "description", content: "A live human answer interface." },
	];
}

export default function Home() {
	const [clientId, setClientId] = useState("");
	const [state, setState] = useState<PublicState>({ conversation: null });
	const [text, setText] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
	const messagesRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let stored = window.localStorage.getItem("adamgpt-client-id");
		if (!stored) {
			stored = crypto.randomUUID();
			window.localStorage.setItem("adamgpt-client-id", stored);
		}
		setClientId(stored);
	}, []);

	useEffect(() => {
		if (!clientId) {
			return;
		}

		let closed = false;
		let retry: number | undefined;

		const connect = () => {
			setConnection("connecting");
			const protocol = window.location.protocol === "https:" ? "wss" : "ws";
			const socket = new WebSocket(`${protocol}://${window.location.host}/ws?role=user&clientId=${clientId}`);

			socket.onopen = () => setConnection("live");
			socket.onmessage = (event) => {
				const envelope = JSON.parse(event.data) as SocketEnvelope;
				if (envelope.type === "public_state") {
					setState(envelope.state);
				}
			};
			socket.onclose = () => {
				if (!closed) {
					setConnection("offline");
					retry = window.setTimeout(connect, 1200);
				}
			};
			socket.onerror = () => socket.close();
		};

		void fetch(`/api/state?clientId=${clientId}`)
			.then((response) => response.json() as Promise<PublicState>)
			.then((nextState) => setState(nextState))
			.catch(() => setConnection("offline"));
		connect();

		return () => {
			closed = true;
			window.clearTimeout(retry);
		};
	}, [clientId]);

	useEffect(() => {
		messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
	}, [state.conversation?.messages.length]);

	const messages = state.conversation?.messages ?? [];
	const isQueued = state.conversation?.status === "queued";
	const subtitle = useMemo(() => {
		if (connection === "live") {
			return isQueued ? "Queued" : "Live";
		}
		return connection === "connecting" ? "Connecting" : "Reconnecting";
	}, [connection, isQueued]);

	async function sendMessage(messageText = text) {
		const trimmed = messageText.trim();
		if (!trimmed || !clientId || isSending) {
			return;
		}

		setIsSending(true);
		setText("");

		try {
			const response = await fetch("/api/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ clientId, text: trimmed }),
			});

			if (!response.ok) {
				throw new Error("Message failed");
			}

			setState((await response.json()) as PublicState);
		} finally {
			setIsSending(false);
		}
	}

	return (
		<main className="min-h-screen bg-[#f7f4ef] text-[#171717]">
			<section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-4 sm:px-6 lg:px-8">
				<header className="flex items-center justify-between border-b border-[#ded7c9] py-4">
					<a className="flex items-center gap-3" href="/">
						<span className="grid size-10 place-items-center rounded-full bg-[#171717] text-sm font-semibold text-[#f7f4ef]">
							AG
						</span>
						<span>
							<span className="block text-lg font-semibold tracking-normal">AdamGPT</span>
							<span className="block text-sm text-[#6d665d]">Ask anything</span>
						</span>
					</a>
					<div className="flex items-center gap-2 rounded-full border border-[#d1c8b9] bg-white px-3 py-2 text-sm text-[#59544d]">
						<span
							className={`size-2 rounded-full ${
								connection === "live" ? "bg-[#1f8a5b]" : connection === "connecting" ? "bg-[#b68423]" : "bg-[#b94242]"
							}`}
						/>
						{subtitle}
					</div>
				</header>

				<div className="grid flex-1 gap-5 py-5 lg:grid-cols-[280px_minmax(0,1fr)]">
					<aside className="hidden border-r border-[#ded7c9] pr-5 lg:block">
						<div className="space-y-3">
							<p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7a7166]">Prompts</p>
							{starterPrompts.map((prompt) => (
								<button
									className="w-full rounded-lg border border-[#d8d0c1] bg-white px-4 py-3 text-left text-sm text-[#2a2927] shadow-sm transition hover:border-[#89806f] hover:bg-[#fffdf8]"
									key={prompt}
									onClick={() => setText(prompt)}
									type="button"
								>
									{prompt}
								</button>
							))}
						</div>
					</aside>

					<section className="flex min-h-[calc(100vh-124px)] flex-col overflow-hidden rounded-lg border border-[#d8d0c1] bg-[#fffdf8] shadow-sm">
						<div ref={messagesRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
							{messages.length === 0 ? (
								<div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center">
									<div className="mb-5 grid size-16 place-items-center rounded-full bg-[#171717] text-xl font-semibold text-[#f7f4ef]">
										AG
									</div>
									<h1 className="text-3xl font-semibold tracking-normal sm:text-5xl">AdamGPT</h1>
									<p className="mt-3 max-w-lg text-base leading-7 text-[#605a52]">
										Send a prompt and Adam will answer from the other side.
									</p>
								</div>
							) : (
								messages.map((message) => (
									<article
										className={`flex ${message.sender === "user" ? "justify-end" : "justify-start"}`}
										key={message.id}
									>
										<div
											className={`max-w-[82%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm sm:max-w-[70%] ${
												message.sender === "user"
													? "bg-[#263d63] text-white"
													: "border border-[#d8d0c1] bg-white text-[#22201d]"
											}`}
										>
											{message.text}
										</div>
									</article>
								))
							)}
							{isQueued && (
								<div className="flex justify-start">
									<div className="rounded-lg border border-[#d8d0c1] bg-white px-4 py-3 text-sm text-[#5f574d] shadow-sm">
										Waiting for Adam<span className="loading-dots" />
									</div>
								</div>
							)}
						</div>

						<form
							className="border-t border-[#ded7c9] bg-white p-3 sm:p-4"
							onSubmit={(event) => {
								event.preventDefault();
								void sendMessage();
							}}
						>
							<div className="flex items-end gap-3">
								<textarea
									className="min-h-14 flex-1 resize-none rounded-lg border border-[#cfc6b8] bg-[#fffdf8] px-4 py-3 text-base leading-6 text-[#171717] outline-none transition placeholder:text-[#8b8275] focus:border-[#263d63] focus:ring-2 focus:ring-[#263d63]/15"
									onChange={(event) => setText(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
											void sendMessage();
										}
									}}
									placeholder="Message AdamGPT"
									rows={1}
									value={text}
								/>
								<button
									className="grid size-14 shrink-0 place-items-center rounded-lg bg-[#171717] text-white transition hover:bg-[#2d2c29] disabled:cursor-not-allowed disabled:bg-[#aaa39a]"
									disabled={!text.trim() || isSending}
									title="Send message"
									type="submit"
								>
									<span aria-hidden="true" className="text-xl leading-none">↑</span>
									<span className="sr-only">Send</span>
								</button>
							</div>
						</form>
					</section>
				</div>
			</section>
		</main>
	);
}
