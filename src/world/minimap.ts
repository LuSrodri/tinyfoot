// The little overview map in the corner: Google 2D satellite imagery through Cesium ion
// (Google content only, as the Google tiles' terms require), with a marker where you are.

import { Cartesian2, Cartesian3, CesiumWidget, Color, Google2DImageryProvider, ImageryLayer, PointPrimitiveCollection, SceneMode, type PointPrimitive } from 'cesium';
import type { World } from './world';

export class Minimap {
  private widget: CesiumWidget;
  private marker: PointPrimitive;
  private last = '';

  constructor(container: HTMLElement, private readonly world: World) {
    this.widget = new CesiumWidget(container, {
      sceneMode: SceneMode.SCENE2D,
      baseLayer: ImageryLayer.fromProviderAsync(Google2DImageryProvider.fromIonAssetId({ assetId: 3830182 as never }) as never),
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      useBrowserRecommendedResolution: true,
      skyAtmosphere: false,
      skyBox: false,
    });
    const scene = this.widget.scene;
    scene.screenSpaceCameraController.enableInputs = false;
    const points = scene.primitives.add(new PointPrimitiveCollection()) as PointPrimitiveCollection;
    this.marker = points.add({ position: Cartesian3.ZERO, pixelSize: 9, color: Color.fromCssColorString('#ff7a1a'), outlineColor: Color.WHITE, outlineWidth: 2 });
    // Click the minimap to jump there.
    container.addEventListener('click', (e) => {
      const rect = container.getBoundingClientRect();
      const c = scene.camera.pickEllipsoid(new Cartesian2(e.clientX - rect.left, e.clientY - rect.top));
      if (!c) return;
      const g = scene.globe.ellipsoid.cartesianToCartographic(c);
      world.flyTo({ center: [(g.longitude * 180) / Math.PI, (g.latitude * 180) / Math.PI], duration: 1600 });
    });
  }

  /** Keeps the overview centred on the main view, a few kilometres across. */
  update(): void {
    const v = this.world.view();
    const span = Math.max(1500, Math.min(2e7, v.mpp * this.world.getCanvas().clientWidth * 6));
    const key = `${v.lat.toFixed(4)},${v.lng.toFixed(4)},${Math.round(Math.log2(span) * 4)}`;
    if (key === this.last) return;
    this.last = key;
    this.marker.position = Cartesian3.fromDegrees(v.lng, v.lat);
    this.widget.scene.camera.setView({ destination: Cartesian3.fromDegrees(v.lng, v.lat, span) });
    this.widget.scene.requestRender();
  }
}
