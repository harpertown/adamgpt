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
	const [pendingImage, setPendingImage] = useState<File | null>(null);
	const [imagePreview, setImagePreview] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
	const messagesRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

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
	const hasMessages = messages.length > 0;

	const statusText = useMemo(() => {
		if (connection === "live") {
			return isQueued ? "Thinking" : "Online";
		}
		return connection === "connecting" ? "Connecting" : "Reconnecting";
	}, [connection, isQueued]);

	const statusColor =
		connection === "live"
			? isQueued
				? "bg-[#f0b429]"
				: "bg-[#34d399]"
			: connection === "connecting"
				? "bg-[#f0b429]"
				: "bg-[#ef4444]";

	function attachImage(file: File) {
		setPendingImage(file);
		const url = URL.createObjectURL(file);
		setImagePreview(url);
	}

	function removeImage() {
		if (imagePreview) {
			URL.revokeObjectURL(imagePreview);
		}
		setPendingImage(null);
		setImagePreview("");
	}

	async function sendMessage(messageText = text) {
		const trimmed = messageText.trim();
		if ((!trimmed && !pendingImage) || !clientId || isSending) {
			return;
		}

		setIsSending(true);
		setText("");

		try {
			let imageId: string | undefined;

			if (pendingImage) {
				const uploadResponse = await fetch("/api/upload", {
					method: "POST",
					headers: { "Content-Type": pendingImage.type },
					body: pendingImage,
				});

				if (!uploadResponse.ok) {
					throw new Error("Image upload failed");
				}

				const uploadResult = (await uploadResponse.json()) as { imageId: string };
				imageId = uploadResult.imageId;
				removeImage();
			}

			const response = await fetch("/api/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ clientId, text: trimmed, imageId }),
			});

			if (!response.ok) {
				throw new Error("Message failed");
			}

			setState((await response.json()) as PublicState);
		} finally {
			setIsSending(false);
		}
	}

	function autoResize() {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = Math.min(el.scrollHeight, 200) + "px";
	}

	return (
		<main className="flex min-h-screen flex-col bg-[#0a0a0a] text-[#e4e4e7]">
			<header className="flex shrink-0 items-center justify-between px-5 py-3">
				<a className="flex items-center gap-2.5" href="/">
					<span className="text-[15px] font-semibold tracking-[-0.01em] text-[#fafafa]">
						AdamGPT
					</span>
				</a>
				<div className="flex items-center gap-2 text-xs text-[#71717a]">
					<span className={`size-1.5 rounded-full ${statusColor}`} />
					{statusText}
				</div>
			</header>

			<div className="flex flex-1 flex-col">
				{!hasMessages ? (
					<div className="flex flex-1 flex-col items-center justify-center px-4 pb-8">
						<div className="mb-10 text-center">
							<h1 className="text-[28px] font-semibold tracking-[-0.03em] text-[#fafafa] sm:text-[36px]">
								AdamGPT
							</h1>
							<p className="mt-2 text-[15px] leading-relaxed text-[#71717a]">
								Ask anything. A human answers.
							</p>
						</div>

						<div className="w-full max-w-[640px]">
							<InputArea
								autoResize={autoResize}
								imagePreview={imagePreview}
								isSending={isSending}
								onAttach={attachImage}
								onRemoveImage={removeImage}
								onSend={() => void sendMessage()}
								onTextChange={setText}
								text={text}
								textareaRef={textareaRef}
							/>

							<div className="mt-4 flex flex-wrap justify-center gap-2">
								{starterPrompts.map((prompt) => (
									<button
										className="rounded-lg border border-[#27272a] bg-transparent px-3.5 py-2 text-[13px] text-[#a1a1aa] transition-colors hover:border-[#3f3f46] hover:text-[#d4d4d8]"
										key={prompt}
										onClick={() => {
											setText(prompt);
											textareaRef.current?.focus();
										}}
										type="button"
									>
										{prompt}
									</button>
								))}
							</div>
						</div>
					</div>
				) : (
					<>
						<div ref={messagesRef} className="flex-1 overflow-y-auto">
							<div className="mx-auto w-full max-w-[640px] px-4 py-6">
								{messages.map((message) => (
									<div
										className={`py-4${
											message.sender === "assistant" ? " border-t border-[#1e1e21]" : ""
										}`}
										key={message.id}
									>
										<div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[#52525b]">
											{message.sender === "user" ? "You" : "AdamGPT"}
										</div>
										{message.imageId && (
											<img
												alt="Attached image"
												className="mb-2 max-h-64 rounded-lg"
												loading="lazy"
												src={`/api/images/${message.imageId}`}
											/>
										)}
										{message.text && (
											<div
												className={`text-[15px] leading-[1.7] ${
													message.sender === "user" ? "text-[#d4d4d8]" : "text-[#fafafa]"
												}`}
											>
												{message.text}
											</div>
										)}
									</div>
								))}
								{isQueued && (
									<div className="border-t border-[#1e1e21] py-4">
										<div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[#52525b]">
											AdamGPT
										</div>
										<div className="flex items-center gap-2 text-[15px] text-[#52525b]">
											<span className="thinking-dots inline-flex gap-0.5">
												<span className="thinking-dot" />
												<span className="thinking-dot" />
												<span className="thinking-dot" />
											</span>
											<span>Waiting for AdamGPT</span>
										</div>
									</div>
								)}
							</div>
						</div>

						<div className="shrink-0 border-t border-[#1e1e21] bg-[#0a0a0a]">
							<div className="mx-auto w-full max-w-[640px] px-4 py-4">
								<InputArea
									autoResize={autoResize}
									imagePreview={imagePreview}
									isSending={isSending}
									onAttach={attachImage}
									onRemoveImage={removeImage}
									onSend={() => void sendMessage()}
									onTextChange={setText}
									text={text}
									textareaRef={textareaRef}
								/>
							</div>
						</div>
					</>
				)}
			</div>
		</main>
	);
}

function InputArea({
	autoResize,
	imagePreview,
	isSending,
	onAttach,
	onRemoveImage,
	onSend,
	onTextChange,
	text,
	textareaRef,
}: {
	autoResize: () => void;
	imagePreview: string;
	isSending: boolean;
	onAttach: (file: File) => void;
	onRemoveImage: () => void;
	onSend: () => void;
	onTextChange: (value: string) => void;
	text: string;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const fileInputRef = useRef<HTMLInputElement>(null);

	function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		if (file && file.type.startsWith("image/")) {
			onAttach(file);
		}
		event.target.value = "";
	}

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				onSend();
			}}
		>
			<div className="relative rounded-xl border border-[#27272a] bg-[#18181b] transition-colors focus-within:border-[#3f3f46]">
				{imagePreview && (
					<div className="px-4 pt-3">
						<div className="group relative inline-block">
							<img
								alt="Upload preview"
								className="h-20 rounded-lg object-cover"
								src={imagePreview}
							/>
							<button
								className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-[#3f3f46] text-[#fafafa] opacity-0 transition-opacity group-hover:opacity-100"
								onClick={onRemoveImage}
								type="button"
							>
								<svg className="size-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
									<path d="M18 6 6 18M6 6l12 12" />
								</svg>
							</button>
						</div>
					</div>
				)}
				<textarea
					ref={textareaRef}
					className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-12 text-[15px] leading-relaxed text-[#fafafa] outline-none placeholder:text-[#52525b]"
					onChange={(event) => {
						onTextChange(event.target.value);
						autoResize();
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							onSend();
						}
					}}
					placeholder="Send a message..."
					rows={1}
					value={text}
				/>
				<input
					ref={fileInputRef}
					accept="image/*"
					className="hidden"
					onChange={handleFileSelect}
					type="file"
				/>
				<div className="absolute right-2 bottom-2 flex items-center gap-1.5">
					<button
						className="grid size-8 place-items-center rounded-lg text-[#52525b] transition-colors hover:text-[#a1a1aa]"
						onClick={() => fileInputRef.current?.click()}
						title="Attach image"
						type="button"
					>
						<svg className="size-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} viewBox="0 0 24 24">
							<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
						</svg>
						<span className="sr-only">Attach image</span>
					</button>
					<button
						className="grid size-8 place-items-center rounded-lg bg-[#fafafa] text-[#0a0a0a] transition-opacity hover:opacity-80 disabled:opacity-30"
						disabled={(!text.trim() && !imagePreview) || isSending}
						title="Send message"
						type="submit"
					>
						<svg
							className="size-4"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							viewBox="0 0 24 24"
						>
							<path d="M5 12h14M12 5l7 7-7 7" />
						</svg>
						<span className="sr-only">Send</span>
					</button>
				</div>
			</div>
		</form>
	);
}
