import type * as Party from "partykit/server";

type BuildType = "wall" | "floor" | "ramp";

type BuildPieceData = {
  id: string;
  type: BuildType;
  position: [number, number, number];
  rotation: [number, number, number];
};

type RemotePlayer = {
  id: string;
  position: [number, number, number];
  rotation: [number, number, number];
};

type ClientMessage =
  | { type: "playerMove"; position: [number, number, number]; rotation: [number, number, number] }
  | { type: "placeBuild"; build: Omit<BuildPieceData, "id"> };

type ServerMessage =
  | { type: "initState"; players: RemotePlayer[]; builds: BuildPieceData[]; online: number }
  | { type: "playerJoined"; player: RemotePlayer; online: number }
  | { type: "playerLeft"; id: string; online: number }
  | { type: "playerMoved"; player: RemotePlayer }
  | { type: "buildPlaced"; build: BuildPieceData; online: number };

export default class ArenaServer implements Party.Server {
  players = new Map<string, RemotePlayer>();
  builds: BuildPieceData[] = [];

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection) {
    const player: RemotePlayer = {
      id: connection.id,
      position: [0, 2, 0],
      rotation: [0, 0, 0],
    };
    this.players.set(connection.id, player);

    this.send(connection, {
      type: "initState",
      players: [...this.players.values()].filter((p) => p.id !== connection.id),
      builds: this.builds,
      online: this.players.size,
    });

    this.broadcast({
      type: "playerJoined",
      player,
      online: this.players.size,
    });
  }

  onMessage(raw: string, sender: Party.Connection) {
    let message: ClientMessage | null = null;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    if (!message) return;

    if (message.type === "playerMove") {
      const current = this.players.get(sender.id);
      if (!current) return;

      current.position = message.position;
      current.rotation = message.rotation;
      this.players.set(sender.id, current);

      this.broadcast({
        type: "playerMoved",
        player: current,
      });
      return;
    }

    if (message.type === "placeBuild") {
      const build: BuildPieceData = {
        id: crypto.randomUUID(),
        ...message.build,
      };
      this.builds.push(build);

      this.broadcast({
        type: "buildPlaced",
        build,
        online: this.players.size,
      });
    }
  }

  onClose(connection: Party.Connection) {
    this.players.delete(connection.id);
    this.broadcast({
      type: "playerLeft",
      id: connection.id,
      online: this.players.size,
    });
  }

  private send(connection: Party.Connection, message: ServerMessage) {
    connection.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage) {
    this.room.broadcast(JSON.stringify(message));
  }
}
