export type Sender = "user" | "assistant";
export type ConversationStatus = "queued" | "answered";

export type ChatMessage = {
	id: string;
	conversationId: string;
	sender: Sender;
	text: string;
	imageId?: string;
	fileId?: string;
	createdAt: number;
};

export type ClientMeta = {
	ip: string;
	userAgent: string;
	country: string;
	city: string;
	region: string;
	timezone: string;
};

export type ConversationSummary = {
	id: string;
	clientId: string;
	displayName: string;
	status: ConversationStatus;
	createdAt: number;
	updatedAt: number;
	lastMessage: string;
	messages: ChatMessage[];
	clientMeta: ClientMeta;
};

export type PublicState = {
	conversation: ConversationSummary | null;
};

export type OperatorState = {
	conversations: ConversationSummary[];
	queuedCount: number;
};

export type SocketEnvelope =
	| { type: "public_state"; state: PublicState }
	| { type: "operator_state"; state: OperatorState }
	| { type: "conversation_deleted" };
