import { SLOT_MACHINE_CONFIG } from "@coin-pusher/shared";

export interface HoleTooltipData {
  holeId: "left" | "right";
  x: number;
  y: number;
}

interface HoleTooltipProps {
  data: HoleTooltipData;
  slotCounter: number;
}

export function HoleTooltip({ data, slotCounter }: HoleTooltipProps) {
  const triggerCount = SLOT_MACHINE_CONFIG.TRIGGER_COUNT;
  const progress = Math.min(slotCounter / triggerCount, 1);

  return (
    <div
      className="hole-tooltip"
      style={{
        left: data.x,
        top: data.y,
      }}
    >
      {data.holeId === "left" ? (
        <>
          <div className="hole-tooltip-text">
            Collect coins to spin! {slotCounter}/{triggerCount}
          </div>
          <div className="hole-tooltip-bar-bg">
            <div
              className="hole-tooltip-bar-fill"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </>
      ) : (
        <div className="hole-tooltip-text">Coming soon...</div>
      )}
    </div>
  );
}
