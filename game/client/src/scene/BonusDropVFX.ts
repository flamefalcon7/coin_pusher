/**
 * BonusDropVFX — full-width CSS overlay banner for sponsor bonus drop events.
 * Uses textContent (NEVER innerHTML) for sponsor name to prevent XSS.
 */
export class BonusDropVFX {
  private bannerElement: HTMLDivElement | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;

  showBonusDrop(sponsorName: string, tokenSymbol: string, brandColor: string, coinCount: number): void {
    // Remove existing banner if any
    this.removeBanner();

    const banner = document.createElement("div");
    banner.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 100%",
      "padding: 12px 16px",
      "text-align: center",
      "font-family: 'Baloo 2', cursive, sans-serif",
      "font-size: 24px",
      "font-weight: 700",
      "color: #ffffff",
      `background: ${brandColor}`,
      "z-index: 500",
      "pointer-events: none",
      "animation: bonusDropSlideIn 0.3s ease-out",
    ].join("; ");

    // Use textContent for XSS prevention — never innerHTML
    banner.textContent = `Bonus Drop! ${coinCount} ${tokenSymbol} from ${sponsorName}`;

    // Inject keyframe animation if not already present
    if (!document.getElementById("bonusDropKeyframes")) {
      const style = document.createElement("style");
      style.id = "bonusDropKeyframes";
      style.textContent = `
        @keyframes bonusDropSlideIn {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0);     opacity: 1; }
        }
        @keyframes bonusDropSlideOut {
          from { transform: translateY(0);     opacity: 1; }
          to   { transform: translateY(-100%); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(banner);
    this.bannerElement = banner;

    // Auto-dismiss after 3 seconds
    this.dismissTimer = setTimeout(() => {
      if (this.bannerElement) {
        this.bannerElement.style.animation = "bonusDropSlideOut 0.3s ease-in forwards";
        setTimeout(() => this.removeBanner(), 300);
      }
    }, 3000);
  }

  private removeBanner(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    if (this.bannerElement) {
      this.bannerElement.remove();
      this.bannerElement = null;
    }
  }

  dispose(): void {
    this.removeBanner();
  }
}
