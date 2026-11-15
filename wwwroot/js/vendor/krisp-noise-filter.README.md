# LiveKit Noise Filter

## Audio chain

This package runs in the browser as a **track processor** on the local microphone capture. Cleaned audio is then published to the room.

```mermaid
flowchart LR
  subgraph client["Browser client"]
    Mic["Microphone"] --> Capture["livekit-client capture"]
    Capture --> Processor["@livekit/krisp-noise-filter (track processor)"]
    Processor --> Publish["Publish track"]
  end
  Publish --> Room["LiveKit room"]
```

## Usage

```ts

import { KrispNoiseFilter } from '@livekit/krisp-noise-filter';

...

await localAudioTrack.setProcessor(KrispNoiseFilter());

```
