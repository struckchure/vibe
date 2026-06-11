import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Read clipboard text with Tauri, then web fallbacks. */
export async function readClipboardText(): Promise<string | null> {
  try {
    const text = await readText();
    if (text) {
      return text;
    }
  } catch {
    /* try web clipboard */
  }

  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      /* fall through */
    }
  }

  return null;
}

/** Copy text with Tauri clipboard, then web fallbacks for mobile WebViews. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeText(text);
    return;
  } catch {
    /* try web clipboard */
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error("Could not copy to clipboard — select the link text manually");
  }
}
