import './MaintenancePage.css';

export default function MaintenancePage() {
  return (
    <main className="maintenance">
      <div className="maintenance__coins" aria-hidden="true">
        <span className="maintenance__coin" />
        <span className="maintenance__coin" />
        <span className="maintenance__coin" />
      </div>
      <h1 className="maintenance__title">We're revamping</h1>
      <p className="maintenance__body">
        Coin Push is off the table while we rebuild the machine. Thanks for playing. See you when we're back.
      </p>
    </main>
  );
}
