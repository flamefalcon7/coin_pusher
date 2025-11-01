# 🎨 Coin Pusher Client

Browser-based 3D client with BabylonJS rendering and real-time server synchronization.

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Run development server (with HMR)
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview
```

Client will start on `http://localhost:5173`

## 📁 Project Structure

```
client/
├── src/
│   ├── main.tsx           # React entry point
│   ├── App.tsx            # Main application
│   ├── App.css            # Styles
│   ├── ui/                # React UI components
│   │   ├── HUD.tsx
│   │   ├── CoinInsertButton.tsx
│   │   └── ConnectionStatus.tsx
│   ├── scene/             # BabylonJS 3D rendering
│   │   ├── SceneManager.ts
│   │   ├── CameraSetup.ts
│   │   ├── Lighting.ts
│   │   ├── StaticMeshes.ts
│   │   ├── PusherMesh.ts
│   │   └── CoinMeshManager.ts
│   └── net/               # Networking layer
│       ├── WebSocketClient.ts
│       ├── ClockSync.ts
│       ├── StateBuffer.ts
│       ├── Interpolator.ts
│       └── GameClient.ts
├── index.html
├── vite.config.ts
└── package.json
```

## ⚙️ Configuration

Create `.env` file (see `.env.example`):

```bash
VITE_WS_URL=ws://localhost:3000
```

## 🎨 Scene Architecture

### Coordinate System
- **Right-handed** (explicitly set)
- **Y-up**: Vertical axis
- **Z-forward**: Depth axis

### Components

**Camera (ArcRotateCamera):**
- Target: `(0, 0.3, 0)`
- Alpha: `-π/2`
- Beta: `π/3`
- Radius: 3m (limits: 2-4m)
- Smooth controls with inertia

**Lighting:**
- Hemispheric light
- Intensity: 0.8
- No real-time shadows (PoC)

**Static Meshes:**
- Platform: 1.2m × 0.05m × 0.8m (gray)
- Walls: Left, Right, Back (blue-gray)
- Drop zone: Semi-transparent indicator

**Pusher:**
- Blue rectangular plate
- Position updated from server state

**Coins:**
- Gold cylinders (thin instances)
- Efficient rendering for many coins
- Position & rotation interpolated

## 🌐 Network Layer

### WebSocket Client
- Connects to server on mount
- Handles reconnection
- Rate-limited ping (every 5s)

### Clock Synchronization
- RTT measurement via ping/pong
- Median of last 5 samples
- Offset calculation: `(serverTime - clientTime) - RTT/2`

### State Buffer
- Stores server state updates
- Maintains ~3 seconds of history
- Provides states for interpolation

### Interpolator
- **Delay**: 100-120ms behind server
- **Position**: Linear interpolation (lerp)
- **Rotation**: Spherical linear interpolation (slerp)
- **Update rate**: 60fps (16ms intervals)

## 🎮 Update Loop

Runs at **60fps**:

1. Update game client (check for pings)
2. Get interpolated state from buffer
3. Update pusher position
4. For each coin:
   - If new: add to scene
   - If exists: update position/rotation
5. Remove despawned coins
6. Update UI (coin count)

## 🖼️ UI Components

### HUD (Top Right)
- FPS counter
- Ping (RTT in ms)
- Active coin count

### Connection Status (Top Left)
- 🔄 Connecting... (yellow)
- ✅ Connected (green)
- ❌ Disconnected (red)

### Insert Coin Button (Bottom Center)
- Disabled when disconnected
- Generates random x position
- Sends to server via WebSocket
- Visual feedback (100ms cooldown)

## 📊 Performance Optimizations

- **Thin Instances**: Single mesh for all coins
- **Fixed Update Rate**: Stable 60fps interpolation
- **Camera Limits**: Prevent excessive zoom
- **No Shadows**: Disabled for PoC
- **Low Poly Meshes**: Simple geometry

## 🎯 State Management

React manages:
- FPS counter
- Connection status
- Ping value
- Coin count
- Button state

Scene manages:
- 3D rendering
- Mesh updates
- Camera controls

Network manages:
- WebSocket connection
- Clock synchronization
- State interpolation
- Coin lifecycle

## 🧪 Testing

### Visual Testing
1. Open browser dev tools (F12)
2. Check console for connection logs
3. Watch FPS counter (should be ≥30)
4. Check ping value (should be <50ms local)
5. Insert coins and verify smooth motion

### Multi-Tab Testing
1. Open 2+ browser tabs
2. Insert coin in tab A
3. Verify coin appears in tab B
4. Check synchronization quality

## 📦 Dependencies

**Core:**
- `react` - UI framework
- `@babylonjs/core` - 3D rendering
- `@coin-pusher/shared` - Shared types

**Build:**
- `vite` - Build tool & dev server
- `typescript` - Type safety
- `@vitejs/plugin-react` - React support

## 🐛 Debugging

### Console Logs
```javascript
// Connection
✅ WebSocket connected
📸 World snapshot received: N bodies
⏱️ RTT: XXms, Offset: XXms

// Rendering
🎮 Initializing BabylonJS scene...
✅ Right-handed coordinate system enabled
📷 Camera initialized
💡 Lighting initialized
🪙 Coin prototype created
```

### Check WebSocket
```javascript
// In browser console
ws = new WebSocket('ws://localhost:3000');
ws.onopen = () => console.log('Connected');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

### Monitor Performance
- Chrome DevTools > Performance tab
- Check frame rate consistency
- Monitor network traffic
- Inspect WebSocket messages

## 🎨 Customization

### Change Materials
```typescript
// In StaticMeshes.ts
material.diffuseColor = new Color3(r, g, b);
material.specularColor = new Color3(r, g, b);
```

### Adjust Camera
```typescript
// In CameraSetup.ts
this.camera.lowerRadiusLimit = 1.5;  // Min zoom
this.camera.upperRadiusLimit = 5;    // Max zoom
```

### Modify Interpolation
```typescript
// In App.tsx
const updateInterval = setInterval(() => {
  // Adjust interval for different update rates
}, 16); // 60fps
```

## 📱 Mobile Support

- Touch controls for camera
- Responsive UI elements
- Performance-optimized rendering
- Tested on iOS/Android browsers

## ⚡ Build & Deploy

```bash
# Production build
pnpm build

# Output in dist/
# Deploy to any static hosting:
# - Vercel
# - Netlify
# - GitHub Pages
# - AWS S3 + CloudFront
```

**Environment Variables:**
```bash
# Set in deployment platform
VITE_WS_URL=wss://your-server.com
```

