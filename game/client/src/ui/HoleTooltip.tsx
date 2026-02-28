import { SLOT_MACHINE_CONFIG, JACKPOT_WHEEL_CONFIG } from "@coin-pusher/shared";

export interface HoleTooltipData {
  holeId: "left" | "right";
  x: number;
  y: number;
}

interface HoleTooltipProps {
  data: HoleTooltipData;
  slotCounter: number;
  wheelCounter: number;
}

export function HoleTooltip({ data, slotCounter, wheelCounter }: HoleTooltipProps) {
  const isLeft = data.holeId === "left";
  const triggerCount = isLeft ? SLOT_MACHINE_CONFIG.TRIGGER_COUNT : JACKPOT_WHEEL_CONFIG.TRIGGER_COUNT;
  const counter = isLeft ? slotCounter : wheelCounter;
  const progress = Math.min(counter / triggerCount, 1);
  const label = isLeft ? "Collect coins to spin!" : "Collect coins to spin the wheel!";

  return (
    <div
      className="hole-tooltip"
      style={{
        left: data.x,
        top: data.y,
      }}
    >
      <div className="hole-tooltip-text">
        {label} {counter}/{triggerCount}
      </div>
      <div className="hole-tooltip-bar-bg">
        <div
          className="hole-tooltip-bar-fill"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}
