import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAddContact } from "@/hooks/contacts";
import { parsePeerId } from "@/lib/peer-id";
import { contactKeys } from "@/lib/query-keys";

type DiscoveryDialogsProps = {
  addContactOpen: boolean;
  onAddContactOpenChange: (open: boolean) => void;
};

export function DiscoveryDialogs({
  addContactOpen,
  onAddContactOpenChange,
}: DiscoveryDialogsProps) {
  const queryClient = useQueryClient();
  const addContactMutation = useAddContact();

  const [peerIdInput, setPeerIdInput] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");

  function handleAddContact() {
    const peerId = parsePeerId(peerIdInput);
    const displayName =
      displayNameInput.trim() ||
      (peerId ? `Contact ${peerId.slice(0, 8)}` : "");
    if (!peerId) return;

    addContactMutation.mutate(
      { peerId, displayName },
      {
        onSuccess: () => {
          toast.success("Contact added");
          setPeerIdInput("");
          setDisplayNameInput("");
          onAddContactOpenChange(false);
          queryClient.invalidateQueries({ queryKey: contactKeys.all });
        },
      },
    );
  }

  return (
    <Dialog open={addContactOpen} onOpenChange={onAddContactOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="peer-id">Peer ID</FieldLabel>
            <Input
              id="peer-id"
              value={peerIdInput}
              onChange={(e) => setPeerIdInput(e.target.value)}
              placeholder="Peer ID or vibe://peer/…"
              className="font-mono text-xs"
            />
            <FieldDescription>
              Share your QR from Identity, or open a vibe://peer link. After
              adding each other, use Connect in the chat to share vibe://connect
              links (offer, then answer link back).
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="display-name">Display name</FieldLabel>
            <Input
              id="display-name"
              value={displayNameInput}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button disabled={addContactMutation.isPending} onClick={handleAddContact}>
            {addContactMutation.isPending ? <Spinner /> : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
