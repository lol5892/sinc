import { useState } from "react";
import "./App.css";

export default function App() {
  const [n, setN] = useState(0);

  return (
    <main className="wrap">
      <h1>sinc</h1>
      <p className="lead">
        Одна папка — ПК, телефон, веб. Меняй код, коммить, пушь, на другом устройстве делай{" "}
        <code>git pull</code>.
      </p>
      <div className="card">
        <button type="button" onClick={() => setN((x) => x + 1)}>
          Счётчик: {n}
        </button>
      </div>
    </main>
  );
}
