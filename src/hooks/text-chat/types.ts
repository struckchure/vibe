import type { ContactRef } from "@/types/contact";
import type { Message } from "@/types/chat";

export type UseTextChatProps = {
  /** Fires for every inbound message from any contact. */
  onIncoming?: (
    contact: ContactRef,
    message: Message
  ) => void | Promise<void>;
};

export type UseTextChatLoadProps = { contact: ContactRef };
export type UseTextChatSendProps = { contact: ContactRef; body: string };
export type UseTextChatMarkAsReadProps = { contact: ContactRef };
export type UseTextChatRemoveContactProps = { contact: ContactRef };
export type UseTextChatIsChannelOpenProps = { contact: ContactRef };
