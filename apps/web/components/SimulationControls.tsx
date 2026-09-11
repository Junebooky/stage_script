"use client";

interface SimulationControlsProps {
  live: boolean;
  hold: boolean;
  onStartLive: () => void;
  onStopLive: () => void;
  onPartial: () => void;
  onTrigger: () => void;
  onPause: () => void;
  onWrong: () => void;
  onSkip: () => void;
  onOverlap: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onHold: () => void;
  onResync: () => void;
  onReset: () => void;
}

export function SimulationControls(props: SimulationControlsProps) {
  return (
    <section className="control-deck" aria-label="Simulation and manual controls">
      <div className="control-group live-control">
        <span className="control-label">INPUT</span>
        <button className={`primary-button ${props.live ? "is-live" : ""}`} onClick={props.live ? props.onStopLive : props.onStartLive}>
          <span className="button-led" />
          {props.live ? "STOP MIC" : "START MIC"}
        </button>
      </div>
      <div className="control-divider" />
      <div className="control-group simulation-group">
        <span className="control-label">SIMULATION</span>
        <div className="button-row">
          <button onClick={props.onPartial}>NEXT PARTIAL</button>
          <button onClick={props.onTrigger}>TRIGGER CUE</button>
          <button onClick={props.onPause}>3S PAUSE</button>
          <button onClick={props.onWrong}>WRONG PHRASE</button>
          <button onClick={props.onSkip}>SKIP +1</button>
          <button onClick={props.onOverlap}>OVERLAP</button>
        </div>
      </div>
      <div className="control-divider" />
      <div className="control-group manual-group">
        <span className="control-label">MANUAL</span>
        <div className="button-row compact">
          <button onClick={props.onPrevious} aria-label="Previous segment">←</button>
          <button onClick={props.onNext} aria-label="Next segment">→</button>
          <button className={props.hold ? "active-control" : ""} onClick={props.onHold}>HOLD</button>
          <button onClick={props.onResync}>RESYNC</button>
          <button onClick={props.onReset}>RESET</button>
        </div>
      </div>
    </section>
  );
}

