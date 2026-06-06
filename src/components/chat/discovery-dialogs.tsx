import { useEffect, useRef, useState } from "react";
import { UserPlusIcon } from "lucide-react";
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
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { useAddContact } from "@/hooks/contacts";
import { parsePeerId } from "@/lib/peer-id";
import { contactKeys } from "@/lib/query-keys";
import * as api from "@/lib/tauri";

type DiscoveryDialogsProps = {
  addContactOpen: boolean;
  onAddContactOpenChange: (open: boolean) => void;
  joinRoomOpen: boolean;
  onJoinRoomOpenChange: (open: boolean) => void;
  contactPeerIds: ReadonlySet<string>;
};

export function DiscoveryDialogs({
  addContactOpen,
  onAddContactOpenChange,
  joinRoomOpen,
  onJoinRoomOpenChange,
  contactPeerIds,
}: DiscoveryDialogsProps) {
  const queryClient = useQueryClient();
  const addContact = useAddContact();

  const [peerIdInput, setPeerIdInput] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [roomDisplayName, setRoomDisplayName] = useState("");
  const [roomPeers, setRoomPeers] = useState<api.RoomPeer[]>([]);
  const [roomActivity, setRoomActivity] = useState<api.RoomEvent[]>([]);
  const [inRoom, setInRoom] = useState(false);
  const [joining, setJoining] = useState(false);
  const toastedJoinPeers = useRef(new Set<string>());

  useEffect(() => {
    if (!joinRoomOpen) return;
    void (async () => {
      const status = await api.roomStatus();
      setInRoom(status.inRoom);
      if (status.code) {
        setRoomCode(status.code);
      }
      if (status.inRoom) {
        setRoomPeers(await api.listRoomPeers());
      }
    })();
  }, [joinRoomOpen]);

  useEffect(() => {
    if (!joinRoomOpen || !inRoom) return;
    const interval = setInterval(() => {
      void api.listRoomPeers().then(setRoomPeers);
    }, 2000);
    return () => clearInterval(interval);
  }, [joinRoomOpen, inRoom]);

  useEffect(() => {
    if (!joinRoomOpen) return;
    const unlistenPeer = api.onRoomPeer((peer) => {
      setRoomPeers((prev) => {
        if (prev.some((p) => p.peerId === peer.peerId)) return prev;
        return [...prev, peer];
      });
      if (!toastedJoinPeers.current.has(peer.peerId)) {
        toastedJoinPeers.current.add(peer.peerId);
        toast.message(`${peer.displayName} joined the room`);
      }
    });
    const unlistenEvent = api.onRoomEvent((event) => {
      setRoomActivity((prev) => [...prev, event].slice(-50));
      if (event.kind === "leave") {
        setRoomPeers((prev) =>
          prev.filter((p) => p.peerId !== event.peerId)
        );
      }
    });
    return () => {
      void unlistenPeer.then((fn) => fn());
      void unlistenEvent.then((fn) => fn());
    };
  }, [joinRoomOpen]);

  function handleAddContact() {
    const peerId = parsePeerId(peerIdInput);
    const displayName =
      displayNameInput.trim() ||
      (peerId ? `Contact ${peerId.slice(0, 8)}` : "");
    if (!peerId) return;

    addContact.mutate(
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

  async function handleJoinRoom() {
    const code = roomCode.trim();
    const name = roomDisplayName.trim();
    if (!code || !name || joining) return;
    const status = await api.roomStatus();
    if (status.inRoom && status.code === code) {
      setInRoom(true);
      setRoomPeers(await api.listRoomPeers());
      return;
    }
    setJoining(true);
    try {
      await api.startNetwork();
      await api.joinRoom(code, name);
      setInRoom(true);
      setRoomActivity([
        { kind: "join", peerId: "", displayName: name, at: Date.now() },
      ]);
      setRoomPeers(await api.listRoomPeers());
      toast.success(`In room ${code} as ${name}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setJoining(false);
    }
  }

  async function handleLeaveRoom() {
    await api.leaveRoom();
    setInRoom(false);
    setRoomPeers([]);
    setRoomActivity([]);
    setRoomCode("");
    setRoomDisplayName("");
    onJoinRoomOpenChange(false);
  }

  function handleAddFromRoom(peer: api.RoomPeer) {
    if (contactPeerIds.has(peer.peerId)) return;

    addContact.mutate(
      { peerId: peer.peerId, displayName: peer.displayName },
      {
        onSuccess: () => {
          toast.success(`Added ${peer.displayName}`);
          queryClient.invalidateQueries({ queryKey: contactKeys.all });
        },
      },
    );
  }

  return (
    <>
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
                You can message any contact once you are on the network. Use
                a room only to discover someone's peer ID.
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
            <Button disabled={addContact.isPending} onClick={handleAddContact}>
              {addContact.isPending ? <Spinner /> : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={joinRoomOpen} onOpenChange={onJoinRoomOpenChange}>
        <DialogContent className="max-h-[85vh] flex flex-col gap-0">
          <DialogHeader>
            <DialogTitle>Join room</DialogTitle>
          </DialogHeader>
          {!inRoom ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="room-display-name">Your name</FieldLabel>
                <Input
                  id="room-display-name"
                  value={roomDisplayName}
                  onChange={(e) => setRoomDisplayName(e.target.value)}
                  placeholder="How others see you in this room"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="room-code">Room code</FieldLabel>
                <Input
                  id="room-code"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  placeholder="e.g. ABC123"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleJoinRoom();
                    }
                  }}
                />
                <FieldDescription>
                  Discover people on the same room code (works across cellular
                  and Wi-Fi). After you add each other, you can chat without
                  staying in the room.
                </FieldDescription>
              </Field>
            </FieldGroup>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              {roomActivity.length > 0 ? (
                <ScrollArea className="max-h-24 shrink-0 rounded-md border bg-muted/30">
                  <ul className="space-y-0.5 p-2 text-xs text-muted-foreground">
                    {roomActivity.map((ev, i) => (
                      <li key={`${ev.at}-${ev.peerId}-${i}`}>
                        {ev.kind === "join" ? (
                          <>
                            <span className="font-medium text-foreground">
                              {ev.displayName}
                            </span>{" "}
                            joined
                          </>
                        ) : (
                          <>
                            <span className="font-medium text-foreground">
                              {ev.displayName}
                            </span>{" "}
                            left
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              ) : null}
              <ScrollArea className="max-h-48 min-h-0 flex-1">
                <ItemGroup className="gap-1 p-1">
                  {roomPeers.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                      Waiting for others in the room…
                    </p>
                  ) : (
                    roomPeers.map((peer) => {
                      const added = contactPeerIds.has(peer.peerId);
                      return (
                        <Item key={peer.peerId} size="sm">
                          <ItemContent>
                            <ItemTitle>{peer.displayName}</ItemTitle>
                            <ItemDescription className="font-mono">
                              {peer.peerId.slice(0, 20)}…
                            </ItemDescription>
                          </ItemContent>
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={added || addContact.isPending}
                            onClick={() => handleAddFromRoom(peer)}
                          >
                            <UserPlusIcon data-icon="inline-start" />
                            {added ? "Added" : "Add"}
                          </Button>
                        </Item>
                      );
                    })
                  )}
                </ItemGroup>
              </ScrollArea>
            </div>
          )}
          <DialogFooter>
            {!inRoom ? (
              <Button
                disabled={
                  joining || !roomCode.trim() || !roomDisplayName.trim()
                }
                onClick={handleJoinRoom}
              >
                {joining ? <Spinner /> : "Join"}
              </Button>
            ) : (
              <Button variant="outline" onClick={handleLeaveRoom}>
                Leave room
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
