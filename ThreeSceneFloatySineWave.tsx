import { Canvas, useFrame, useThree, useLoader } from "@react-three/fiber";
import { Suspense, useRef, useMemo, useEffect } from "react";
import * as THREE from "three";
import { deltaTime } from "three/tsl";

// We keep the same pointer detection logic, but our "ideal" positions form a wave.
function ParticleWave({
  count = 1500,
  particleWidth = 2,
}: ThreeSceneFloatySineWaveProps) {
  const { camera } = useThree();

  // Generate param + random offset for each particle
  const { params, randomOffsets } = useMemo(() => {
    const params = new Float32Array(count);         // param in [0..1], used for x
    const randomOffsets = new Float32Array(count);  // random phase offset

    for (let i = 0; i < count; i++) {
      params[i] = i / count;                       // even distribution in [0..1]
      randomOffsets[i] = Math.sin(Math.random() * 2 * Math.PI);
    }

    return { params, randomOffsets };
  }, [count]);

  // We'll store actual positions in a BufferGeometry so we can render them
  // All start at (0, 0, 0), we’ll update in the animation loop
  const positions = useMemo(() => new Float32Array(count * 2), [count]);
  
  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geom;
  }, [positions]);

  // Velocity array so we can do spring physics
  const velocities = useRef(new Float32Array(count * 3));

  // We’ll track the pointer’s unprojected position for repulsion
  const target = useRef(new THREE.Vector3(1000, 1000, 1000));

  // On mount, set up listeners for both pointer and touch events.
  useEffect(() => {
    // Initialize target to the center in world space.
    const centerNDC = new THREE.Vector3(0, 0, 0.8);
    centerNDC.unproject(camera);
    target.current.copy(centerNDC);

    const handlePointerMove = (event: PointerEvent) => {
      if (document.hidden) return;
      const ndc = new THREE.Vector3(
        (event.clientX / window.innerWidth) * 2 - 1,
        -(event.clientY / window.innerHeight) * 2 + 1,
        0.8
      );
      ndc.unproject(camera);
      target.current.copy(ndc);
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (document.hidden) return;
      if (event.touches.length === 0) return;
      const touch = event.touches[0];
      const ndc = new THREE.Vector3(
        (touch.clientX / window.innerWidth) * 2 - 1,
        -(touch.clientY / window.innerHeight) * 2 + 1,
        0.8
      );
      ndc.unproject(camera);
      target.current.copy(ndc);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("touchmove", handleTouchMove);
    };
  }, [camera]);

  // Each frame, we do:
  // 1) Compute each particle's "ideal wave position."
  // 2) Spring toward it + pointer repulsion + inter-particle repulsion.
  useFrame((state, delta) => {
    //!!!limit max delta value. This won't vissually effect the user unless they are dipping below 10fps
    //!!!needed to pause delta when alt tabbed otherwise physics will go crazy when returning to web app after losing focus (alt tabbed)
    delta = delta % 0.1;
    if (document.hidden) return;

    const posAttr = geometry.attributes.position;
    const posArray = posAttr.array as Float32Array;

    const time = performance.now() / 1000; // basic time
    // waveTime for controlling wave movement
    const waveTime = time * 0.6;
    const amplitude = 3; // wave height
    const frequency = 2; // wave frequency
    const xRange = particleWidth;   // wave width in x
    const xOffset = -15 * (particleWidth / 45);  // wave center shift in x (45 is an abitrary value based on centering particle effect between desktop and mobile)
    const waveZ = -10;    // put wave a bit behind camera

    // Spring parameters
    const springFactor = 2.0;
    const damping = 0.95;

    // Camera->pointer line logic for repulsion
    const camPos = camera.position;
    const pointerPos = target.current;
    const lineDir = new THREE.Vector3().subVectors(pointerPos, camPos).normalize();
    const threshold = 7.0;
    const forceMultiplier = 100;

    // We'll store a repulsion force array for inter-particle collisions
    const forceArray = new Float32Array(count * 3);
    const minDist = 0.2; // how close before repulsion

    // 1) Calculate target positions (wave + time)
    for (let i = 0; i < count; i++) {
      const param = params[i];
      const offset = randomOffsets[i];
      // wave base x
      const baseX = xOffset + xRange * param;
      // wave y = amplitude * sin( frequency * (x + waveTime) + offset )
      const waveY = amplitude * Math.sin(frequency * (baseX + waveTime) + offset);

      // The wave shape we want to adopt
      const waveTarget = new THREE.Vector3(baseX, waveY, waveZ);

      // Current position
      const ix = posArray[i * 3];
      const iy = posArray[i * 3 + 1];
      const iz = posArray[i * 3 + 2];
      const currentPos = new THREE.Vector3(ix, iy, iz);

      // Spring force = (waveTarget - currentPos) * springFactor
      const springForce = waveTarget.sub(currentPos).multiplyScalar(springFactor);

      // 2) Pointer line repulsion
      const AP = currentPos.clone().sub(camPos);
      const proj = AP.dot(lineDir);
      const closestPoint = camPos.clone().add(lineDir.clone().multiplyScalar(proj));
      const distance = currentPos.distanceTo(closestPoint);
      let repulsion = new THREE.Vector3();
      if (distance < threshold) {
        const strength = forceMultiplier * Math.pow(1 - distance / threshold, 2);
        repulsion = currentPos.clone().sub(closestPoint).normalize().multiplyScalar(strength);
      }

      // Combine spring + pointer repulsion into an acceleration
      const acceleration = springForce.add(repulsion);

      // Velocity
      const vx = velocities.current[i * 3];
      const vy = velocities.current[i * 3 + 1];
      const vz = velocities.current[i * 3 + 2];
      const v = new THREE.Vector3(vx, vy, vz);

      // Update velocity by acceleration
      v.add(acceleration.multiplyScalar(delta));
      // Apply damping
      v.multiplyScalar(damping);

      // Store back in velocities
      velocities.current[i * 3] = v.x;
      velocities.current[i * 3 + 1] = v.y;
      velocities.current[i * 3 + 2] = v.z;
    }

    // 3) Inter-particle repulsion (avoid overlap):
    for (let i = 0; i < count; i++) {
      const ix = posArray[i * 3];
      const iy = posArray[i * 3 + 1];
      const iz = posArray[i * 3 + 2];
      for (let j = i + 1; j < count; j++) {
        const jx = posArray[j * 3];
        const jy = posArray[j * 3 + 1];
        const jz = posArray[j * 3 + 2];

        const dx = jx - ix;
        const dy = jy - iy;
        const dz = jz - iz;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < minDist * minDist && distSq > 0) {
          const dist = Math.sqrt(distSq);
          let repForce = (minDist - dist) / dist;
          repForce = repForce * repForce;
          const fx = dx * repForce;
          const fy = dy * repForce;
          const fz = dz * repForce;
          forceArray[i * 3] -= fx;
          forceArray[i * 3 + 1] -= fy;
          forceArray[i * 3 + 2] -= fz;
          forceArray[j * 3] += fx;
          forceArray[j * 3 + 1] += fy;
          forceArray[j * 3 + 2] += fz;
        }
      }
    }
    // Apply inter-particle forces
    const repulsionFactor = 2.0;
    for (let i = 0; i < count; i++) {
      const vx = velocities.current[i * 3];
      const vy = velocities.current[i * 3 + 1];
      const vz = velocities.current[i * 3 + 2];
      const v = new THREE.Vector3(vx, vy, vz);

      const fx = forceArray[i * 3];
      const fy = forceArray[i * 3 + 1];
      const fz = forceArray[i * 3 + 2];
      const f = new THREE.Vector3(fx, fy, fz);

      // Add the repulsion from neighbors
      v.add(f.multiplyScalar(repulsionFactor * delta));

      velocities.current[i * 3] = v.x;
      velocities.current[i * 3 + 1] = v.y;
      velocities.current[i * 3 + 2] = v.z;
    }

    // 4) Update positions by velocity
    for (let i = 0; i < count; i++) {
      posArray[i * 3 + 0] += velocities.current[i * 3 + 0] * delta;
      posArray[i * 3 + 1] += velocities.current[i * 3 + 1] * delta;
      posArray[i * 3 + 2] += velocities.current[i * 3 + 2] * delta;
    }

    // Mark geometry as updated
    posAttr.needsUpdate = true;

    // Clear out forceArray for next frame
    forceArray.fill(0);
  });

  // Load dot texture from /public
  const dotTexture = useLoader(THREE.TextureLoader, "/Img/Dot.png");

  return (
    <points geometry={geometry}>
      <pointsMaterial
        attach="material"
        map={dotTexture}
        transparent
        depthWrite={false}
        size={0.1}
        sizeAttenuation
      />
    </points>
  );
}

type ThreeSceneFloatySineWaveProps = {
  count?: number;
  particleWidth?: number;
}

// Put the wave in a full screen fixed <Canvas> behind your content
export function ThreeSceneFloatySineWave({
  count = 1500,
  particleWidth = 20,
}: ThreeSceneFloatySineWaveProps) {
  return (
    <div className="fixed inset-0 pointer-events-none">
      <Canvas
        camera={{
          position: [
            0, 0, 15,
          ],
          fov: 50,
        }}
        className="w-screen h-screen"
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[2, 5, 2]} intensity={2} />
        <Suspense fallback={null}>
          <ParticleWave count={count} particleWidth={particleWidth} />
        </Suspense>
      </Canvas>
    </div>
  );
}
