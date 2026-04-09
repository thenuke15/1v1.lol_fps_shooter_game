"use client";

import dynamic from "next/dynamic";

const Game = dynamic(() => import("./components/game"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-[#91cbff]">
      <div className="text-lg text-white">Loading game...</div>
    </div>
  ),
});

export default function Home() {
  return <Game />;
}
