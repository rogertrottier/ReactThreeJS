import { Canvas, useFrame, useThree, useLoader } from "@react-three/fiber";
import { Suspense, useRef, useEffect } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three-stdlib";

// Hook to track mouse position in normalized device coordinates (NDC)
function useMouseNDC() {
  const mouse = useRef(new THREE.Vector2(0, 0));
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      mouse.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      mouse.current.y = -(event.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener("pointermove", handlePointerMove);
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, []);
  return mouse;
}

type FloatingModelProps = {
  modelPath: string;
  modelScale: number;
};

function FloatingModel({ modelPath, modelScale }: FloatingModelProps) {
  const { camera, size } = useThree();
  const mouse = useMouseNDC();
  const modelRef = useRef<THREE.Group>(null);
  const gltf = useLoader(GLTFLoader, modelPath);

  // Fixed parameters
  const fixedZ = 0; // fixed depth
  const margin = 200; // pixel margin from the canvas edge

  // Spawn position using polar coordinates.
  useEffect(() => {
    if (modelRef.current) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 30;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const startNDC = new THREE.Vector3(x, y, 0.8);
      startNDC.unproject(camera);
      modelRef.current.position.set(startNDC.x, startNDC.y, fixedZ);
    }
  }, [camera]);

  // Initialize with a small random velocity.
  const velocity = useRef(
    new THREE.Vector3((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, 0)
  );

  useFrame((state, delta) => {
    delta = delta % 0.1; 
    if (!modelRef.current) return;
    const pos = modelRef.current.position;

    // --- Compute the world-space bounding box for the visible canvas ---
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -fixedZ);
    const getWorldPoint = (ndc: THREE.Vector2) => {
      const ndcPoint = new THREE.Vector3(ndc.x, ndc.y, 0.5);
      const raycaster = new THREE.Raycaster();
      // Pass the ndc (Vector2) directly.
      raycaster.setFromCamera(ndc, camera);
      const point = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, point);
      return point;
    };

    const lowerLeftWorld = getWorldPoint(new THREE.Vector2(-1, -1));
    const upperRightWorld = getWorldPoint(new THREE.Vector2(1, 1));
    const minX = lowerLeftWorld.x;
    const minY = lowerLeftWorld.y;
    const maxX = upperRightWorld.x;
    const maxY = upperRightWorld.y;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Convert the pixel margin into world units.
    const worldWidth = maxX - minX;
    const worldHeight = maxY - minY;
    const marginX = (margin / size.width) * worldWidth;
    const marginY = (margin / size.height) * worldHeight;

    // --- Compute the model's bounding box to get its edges ---
    const box = new THREE.Box3().setFromObject(modelRef.current);
    // For the x-axis, use the left edge if the model is on the left, right edge if on the right.
    // For simplicity, we'll assume if the model's center is left of the scene center, we use box.min.x, otherwise box.max.x.
    const modelCenter = new THREE.Vector3();
    box.getCenter(modelCenter);
    const modelEdgeX = modelCenter.x < centerX ? box.min.x : box.max.x;
    // Similarly for y:
    const modelEdgeY = modelCenter.y < centerY ? box.min.y : box.max.y;

    // --- Pull Force Calculation using model edges ---
    const pullForce = new THREE.Vector3(0, 0, 0);
    const pullStrength = 20; // force multiplier

    // For x-axis:
    if (modelEdgeX < minX + marginX) {
      // If the left edge is too far left, compute force based on its offset.
      pullForce.x = pullStrength * ((minX + marginX) - modelEdgeX);
    } else if (modelEdgeX > maxX - marginX) {
      pullForce.x = pullStrength * ((maxX - marginX) - modelEdgeX);
    }
    // For y-axis:
    if (modelEdgeY < minY + marginY) {
      pullForce.y = pullStrength * ((minY + marginY) - modelEdgeY);
    } else if (modelEdgeY > maxY - marginY) {
      pullForce.y = pullStrength * ((maxY - marginY) - modelEdgeY);
    }

    // --- Mouse Hover Force via Raycasting (unchanged) ---
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse.current, camera);
    const ray = raycaster.ray;
    const v = pos.clone().sub(ray.origin);
    const proj = v.dot(ray.direction);
    const closestPoint = ray.origin.clone().add(ray.direction.clone().multiplyScalar(proj));
    const distanceToRay = pos.distanceTo(closestPoint);
    const interactionThreshold = 7.5; // in world units
    let mouseForce = new THREE.Vector3(0, 0, 0);
    if (distanceToRay < interactionThreshold) {
      const epsilon = 0.01;
      const pushStrength = 100 * (interactionThreshold / (distanceToRay + epsilon));
      mouseForce = pos.clone().sub(closestPoint).normalize().multiplyScalar(pushStrength);
    }

    // --- Combine Forces and Update Velocity ---
    const totalForce = new THREE.Vector3();
    totalForce.add(pullForce);
    totalForce.add(mouseForce);
    velocity.current.add(totalForce.multiplyScalar(delta));
    velocity.current.multiplyScalar(0.99);
    const minVelocity = 0.02;
    if (velocity.current.length() > 0 && velocity.current.length() < minVelocity) {
      velocity.current.setLength(minVelocity);
    }

    pos.add(velocity.current.clone().multiplyScalar(delta));
    pos.z = fixedZ;

    // Continuous rotation for visual flair.
    modelRef.current.rotation.x += delta * 0.5;
    modelRef.current.rotation.y += delta * 0.3;
    modelRef.current.rotation.z += delta * 0.2;
  });

  return (
    <primitive
      object={gltf.scene}
      ref={modelRef}
      scale={[modelScale, modelScale, modelScale]}
    />
  );
}

type ThreeSceneFloatyModelSwirlProps = {
  modelPath: string;
  modelScale?: number;
  hasLighting?: boolean;
};

export function ThreeSceneFloatyModelSwirl({
  modelPath,
  modelScale = 42,
  hasLighting = true,
}: ThreeSceneFloatyModelSwirlProps) {
  return (
    <div className="fixed inset-0 pointer-events-none">
      <Canvas
        camera={{ position: [0, 0, 50], fov: 50 }}
        style={{ background: "transparent" }}
      >
        {hasLighting ? (
          <>
            <ambientLight intensity={0.5} />
            <directionalLight position={[0, 10, 5]} intensity={1} />
          </>
        ) : (
          <>
          </>
        )}
        <Suspense fallback={null}>
          <FloatingModel modelPath={modelPath} modelScale={modelScale} />
        </Suspense>
      </Canvas>
    </div>
  );
}
