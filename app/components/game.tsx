"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Physics, useBox, useSphere } from "@react-three/cannon";
import { usePartySocket } from "partysocket/react";
import * as THREE from "three";

type BuildType = "wall";

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

type GhostData = {
  type: BuildType;
  position: [number, number, number];
  rotation: [number, number, number];
  canPlace: boolean;
};

type NetMessage =
  | { type: "initState"; players: RemotePlayer[]; builds: BuildPieceData[]; online: number }
  | { type: "playerJoined"; player: RemotePlayer; online: number }
  | { type: "playerLeft"; id: string; online: number }
  | { type: "playerMoved"; player: RemotePlayer }
  | { type: "buildPlaced"; build: BuildPieceData; online: number };

const GRID_SIZE = 3;
const BUILD_RANGE = 12;

function snapToGrid(value: number) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function getPieceSize(): [number, number, number] {
  return [3, 3, 0.5];
}

function getYawHalfExtents(_type: BuildType, yaw: number): [number, number, number] {
  const [sx, sy, sz] = getPieceSize();
  const normalizedYaw = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const quarterTurns = Math.round(normalizedYaw / (Math.PI / 2)) % 4;
  const swapXZ = quarterTurns % 2 === 1;
  const finalX = swapXZ ? sz : sx;
  const finalZ = swapXZ ? sx : sz;
  return [finalX / 2, sy / 2, finalZ / 2];
}

function boxesOverlap(a: Omit<BuildPieceData, "id">, b: Omit<BuildPieceData, "id">) {
  const aHalf = getYawHalfExtents(a.type, a.rotation[1]);
  const bHalf = getYawHalfExtents(b.type, b.rotation[1]);
  const epsilon = 0.01;

  return (
    Math.abs(a.position[0] - b.position[0]) < aHalf[0] + bHalf[0] - epsilon &&
    Math.abs(a.position[1] - b.position[1]) < aHalf[1] + bHalf[1] - epsilon &&
    Math.abs(a.position[2] - b.position[2]) < aHalf[2] + bHalf[2] - epsilon
  );
}

function canPlacePiece(
  candidate: Omit<BuildPieceData, "id">,
  placedPieces: BuildPieceData[],
  playerPosition: [number, number, number],
) {
  const distanceXZ = Math.hypot(
    candidate.position[0] - playerPosition[0],
    candidate.position[2] - playerPosition[2],
  );

  if (distanceXZ > BUILD_RANGE) {
    return false;
  }

  return !placedPieces.some((piece) => boxesOverlap(candidate, piece));
}

/** Wall preview/placement uses player facing (third-person camera looks at player, not forward). */
function getBuildTransformFromPlayerYaw(
  px: number,
  pz: number,
  playerYaw: number,
  yawOffset: number,
) {
  const dirX = Math.sin(playerYaw);
  const dirZ = -Math.cos(playerYaw);
  const distanceAhead = 5;
  const rawX = px + dirX * distanceAhead;
  const rawZ = pz + dirZ * distanceAhead;
  const planeYaw = Math.atan2(dirX, dirZ);
  const snappedYaw = Math.round(planeYaw / (Math.PI / 2)) * (Math.PI / 2) + yawOffset;

  return {
    position: [snapToGrid(rawX), 1.5, snapToGrid(rawZ)] as [number, number, number],
    rotation: [0, snappedYaw, 0] as [number, number, number],
  };
}

function BuildPiece({ position, rotation }: Pick<BuildPieceData, "position" | "rotation">) {
  const boxArgs = getPieceSize();

  const [ref] = useBox(() => ({
    type: "Static",
    args: boxArgs,
    position,
    rotation,
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow>
      <boxGeometry args={boxArgs} />
      <meshStandardMaterial color="#2f6dff" />
    </mesh>
  );
}

function RemotePlayerCapsule({ player }: { player: RemotePlayer }) {
  const [, yaw] = player.rotation;
  return (
    <mesh position={player.position} rotation={[0, yaw, 0]} castShadow>
      <capsuleGeometry args={[0.3, 0.7, 8, 16]} />
      <meshStandardMaterial color="#ef4444" />
    </mesh>
  );
}

function GhostPiece({ ghost }: { ghost: GhostData | null }) {
  if (!ghost) {
    return null;
  }

  const boxArgs = getPieceSize();

  return (
    <mesh position={ghost.position} rotation={ghost.rotation}>
      <boxGeometry args={boxArgs} />
      <meshStandardMaterial
        color={ghost.canPlace ? "#2f6dff" : "#ef4444"}
        transparent
        opacity={0.35}
      />
    </mesh>
  );
}

function ArenaFloor() {
  const halfExtents: [number, number, number] = [150, 0.5, 150];
  const [ref] = useBox(() => ({
    type: "Static",
    args: halfExtents,
    position: [0, -halfExtents[1], 0],
  }));

  const [gridTexture, setGridTexture] = useState<THREE.CanvasTexture | null>(null);

  useEffect(() => {
    const size = 256;
    const cell = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.fillStyle = "#e9ecef";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "#c8ced6";
    ctx.lineWidth = 2;

    for (let i = 0; i <= size; i += cell) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(40, 40);
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;

    setGridTexture(texture);

    return () => {
      texture.dispose();
    };
  }, []);

  return (
    <mesh ref={ref} receiveShadow>
      <boxGeometry args={[halfExtents[0] * 2, halfExtents[1] * 2, halfExtents[2] * 2]} />
      <meshStandardMaterial map={gridTexture ?? undefined} color="#dfe3e8" />
    </mesh>
  );
}

type PlayerControllerProps = {
  placedPieces: BuildPieceData[];
  buildMode: boolean;
  onToggleBuildMode: () => void;
  onPlaceBuild: (piece: Omit<BuildPieceData, "id">) => void;
  onPlayerTransform: (position: [number, number, number], rotation: [number, number, number]) => void;
};

function PlayerController({
  placedPieces,
  buildMode,
  onToggleBuildMode,
  onPlaceBuild,
  onPlayerTransform,
}: PlayerControllerProps) {
  const { camera, gl } = useThree();
  const [playerRef, api] = useSphere(() => ({
    mass: 1,
    args: [0.45],
    position: [0, 2, 0],
    linearDamping: 0.85,
    angularDamping: 1,
    fixedRotation: true,
    material: { friction: 0.35, restitution: 0 },
  }));

  const velocity = useRef<[number, number, number]>([0, 0, 0]);
  const position = useRef<[number, number, number]>([0, 2, 0]);
  const keys = useRef<Record<string, boolean>>({});
  const yaw = useRef(0);
  const pitch = useRef(0);
  const buildYawOffset = useRef(0);
  const [ghost, setGhost] = useState<GhostData | null>(null);
  const ghostRef = useRef<GhostData | null>(null);
  const camDistance = 5.5;
  const camHeight = 1.85;
  const lookAtY = 0.9;
  const speed = 7;
  const jumpForce = 6;
  const syncAccumulator = useRef(0);

  useEffect(() => api.velocity.subscribe((v) => (velocity.current = v)), [api.velocity]);
  useEffect(() => api.position.subscribe((p) => (position.current = p)), [api.position]);
  useEffect(() => {
    ghostRef.current = ghost;
  }, [ghost]);

  useEffect(() => {
    const onClick = () => {
      if (document.pointerLockElement !== gl.domElement) {
        gl.domElement.requestPointerLock();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      keys.current[event.code] = true;

      if (event.code === "KeyQ") {
        onToggleBuildMode();
      } else if (event.code === "KeyR") {
        buildYawOffset.current += Math.PI / 2;
      }

      if (event.code === "Space") {
        const nearGround = Math.abs(position.current[1] - 0.45) < 0.2;
        const lowVerticalSpeed = Math.abs(velocity.current[1]) < 0.1;
        if (nearGround && lowVerticalSpeed) {
          api.velocity.set(velocity.current[0], jumpForce, velocity.current[2]);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      keys.current[event.code] = false;
    };

    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) {
        return;
      }

      const sensitivity = 0.0022;
      yaw.current -= event.movementX * sensitivity;
      pitch.current -= event.movementY * sensitivity;
      pitch.current = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch.current));
    };

    const onMouseDown = (event: MouseEvent) => {
      const currentGhost = ghostRef.current;
      if (
        event.button !== 0 ||
        document.pointerLockElement !== gl.domElement ||
        !buildMode ||
        !currentGhost ||
        !currentGhost.canPlace
      ) {
        return;
      }

      onPlaceBuild({
        type: currentGhost.type,
        position: currentGhost.position,
        rotation: currentGhost.rotation,
      });
    };

    gl.domElement.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mousedown", onMouseDown);

    return () => {
      gl.domElement.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [api.velocity, buildMode, gl.domElement, onPlaceBuild, onToggleBuildMode]);

  useFrame((_, delta) => {
    if (position.current[1] < -12) {
      api.position.set(0, 2, 0);
      api.velocity.set(0, 0, 0);
      return;
    }

    const forward = Number(keys.current.KeyW) - Number(keys.current.KeyS);
    const strafe = Number(keys.current.KeyD) - Number(keys.current.KeyA);

    const dir = new THREE.Vector3(strafe, 0, -forward);
    if (dir.lengthSq() > 0) {
      dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw.current);
    }

    api.velocity.set(dir.x * speed, velocity.current[1], dir.z * speed);

    const [px, py, pz] = position.current;

    api.rotation.set(0, yaw.current, 0);

    const sinY = Math.sin(yaw.current);
    const cosY = Math.cos(yaw.current);
    const backX = -sinY;
    const backZ = cosY;
    const horizDist = Math.max(0.35, Math.cos(pitch.current)) * camDistance;
    const vertLift = Math.sin(pitch.current) * camDistance * 0.45 + camHeight;
    camera.position.set(px + backX * horizDist, py + vertLift, pz + backZ * horizDist);
    camera.lookAt(px, py + lookAtY, pz);

    const snapped = getBuildTransformFromPlayerYaw(px, pz, yaw.current, buildYawOffset.current);
    const canPlace = canPlacePiece(
      {
        type: "wall",
        position: snapped.position,
        rotation: snapped.rotation,
      },
      placedPieces,
      position.current,
    );

    setGhost((prev) => {
      if (
        prev &&
        prev.type === "wall" &&
        prev.position[0] === snapped.position[0] &&
        prev.position[1] === snapped.position[1] &&
        prev.position[2] === snapped.position[2] &&
        prev.rotation[0] === snapped.rotation[0] &&
        prev.rotation[1] === snapped.rotation[1] &&
        prev.rotation[2] === snapped.rotation[2] &&
        prev.canPlace === canPlace
      ) {
        return prev;
      }

      return {
        type: "wall",
        position: snapped.position,
        rotation: snapped.rotation,
        canPlace,
      };
    });

    syncAccumulator.current += delta;
    if (syncAccumulator.current > 0.05) {
      syncAccumulator.current = 0;
      onPlayerTransform(position.current, [pitch.current, yaw.current, 0]);
    }
  });

  return (
    <>
      <mesh ref={playerRef} castShadow position={[0, 2, 0]}>
        <capsuleGeometry args={[0.3, 0.7, 8, 16]} />
        <meshStandardMaterial color="#3f6ed4" />
      </mesh>
      {buildMode ? <GhostPiece ghost={ghost} /> : null}
    </>
  );
}

const PARTY_HOST = (
  process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "https://my-1v1-clone.thenuke15.partykit.dev"
)
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "");
const PARTY_ROOM = process.env.NEXT_PUBLIC_PARTYKIT_ROOM ?? "arena-room";
/** Must match a party route on your PartyKit worker. Default `main` matches `main` in partykit.json. */
const PARTY_NAME = process.env.NEXT_PUBLIC_PARTYKIT_PARTY ?? "main";

type ArenaSceneProps = {
  onOnlineChange: (count: number) => void;
  buildMode: boolean;
  onToggleBuildMode: () => void;
};

function ArenaScene({ onOnlineChange, buildMode, onToggleBuildMode }: ArenaSceneProps) {
  const [builds, setBuilds] = useState<BuildPieceData[]>([]);
  const [remotePlayers, setRemotePlayers] = useState<Record<string, RemotePlayer>>({});
  const onMessage = useCallback(
    (event: MessageEvent) => {
      const message = JSON.parse(event.data as string) as NetMessage;
      if (message.type === "initState") {
        setBuilds(message.builds);
        const nextPlayers: Record<string, RemotePlayer> = {};
        for (const player of message.players) {
          nextPlayers[player.id] = player;
        }
        setRemotePlayers(nextPlayers);
        onOnlineChange(message.online);
      } else if (message.type === "playerJoined") {
        setRemotePlayers((prev) => ({ ...prev, [message.player.id]: message.player }));
        onOnlineChange(message.online);
      } else if (message.type === "playerLeft") {
        setRemotePlayers((prev) => {
          const next = { ...prev };
          delete next[message.id];
          return next;
        });
        onOnlineChange(message.online);
      } else if (message.type === "playerMoved") {
        setRemotePlayers((prev) => ({ ...prev, [message.player.id]: message.player }));
      } else if (message.type === "buildPlaced") {
        setBuilds((prev) => {
          if (prev.some((build) => build.id === message.build.id)) {
            return prev;
          }
          return [...prev, message.build];
        });
        onOnlineChange(message.online);
      }
    },
    [onOnlineChange],
  );

  const socket = usePartySocket({
    host: PARTY_HOST,
    room: PARTY_ROOM,
    party: PARTY_NAME,
    onMessage,
  });

  const handlePlaceBuild = (piece: Omit<BuildPieceData, "id">) => {
    socket.send(
      JSON.stringify({
        type: "placeBuild",
        build: piece,
      }),
    );
  };

  const handlePlayerTransform = (
    position: [number, number, number],
    rotation: [number, number, number],
  ) => {
    socket.send(
      JSON.stringify({
        type: "playerMove",
        position,
        rotation,
      }),
    );
  };

  return (
    <>
      <color attach="background" args={["#91cbff"]} />
      <fog attach="fog" args={["#91cbff", 18, 140]} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[10, 16, 7]}
        intensity={1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <Physics
        gravity={[0, -20, 0]}
        iterations={20}
        maxSubSteps={12}
        allowSleep={false}
        defaultContactMaterial={{ friction: 0.5, restitution: 0 }}
      >
        <ArenaFloor />
        <PlayerController
          placedPieces={builds}
          buildMode={buildMode}
          onToggleBuildMode={onToggleBuildMode}
          onPlaceBuild={handlePlaceBuild}
          onPlayerTransform={handlePlayerTransform}
        />
        {builds.map((piece) => (
          <BuildPiece key={piece.id} position={piece.position} rotation={piece.rotation} />
        ))}
        {Object.values(remotePlayers).map((player) => (
          <RemotePlayerCapsule key={player.id} player={player} />
        ))}
      </Physics>
    </>
  );
}

export default function Game() {
  const [online, setOnline] = useState(1);
  const [buildMode, setBuildMode] = useState(false);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#91cbff]">
      <div className="absolute inset-0 min-h-0">
        <Canvas
          shadows={{ type: THREE.PCFShadowMap }}
          className="block h-full w-full touch-none"
          camera={{ position: [0, 6, 14], fov: 55 }}
        >
          <ArenaScene
            onOnlineChange={setOnline}
            buildMode={buildMode}
            onToggleBuildMode={() => setBuildMode((prev) => !prev)}
          />
        </Canvas>
      </div>

      {!buildMode ? (
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2">
          <div className="absolute left-1/2 top-0 h-4 w-[2px] -translate-x-1/2 bg-white/90" />
          <div className="absolute left-0 top-1/2 h-[2px] w-4 -translate-y-1/2 bg-white/90" />
        </div>
      ) : null}

      <div className="pointer-events-none absolute right-4 top-4 rounded-md bg-black/35 px-3 py-2 text-sm text-white">
        Players Online: {online}
      </div>
      <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-black/35 px-3 py-2 text-sm text-white">
        Mode: {buildMode ? "Build (Q)" : "Combat (Q)"}
      </div>
    </div>
  );
}
