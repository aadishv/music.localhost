import { useEffect, useRef } from "react";
import {
    Application,
    Container,
    Graphics,
    NoiseFilter,
    Point,
    Sprite,
    Texture,
    type SpriteSource,
} from "pixi.js";
import * as PIXI from "pixi.js";
import "@pixi/unsafe-eval";
import { AdjustmentFilter, KawaseBlurFilter, TwistFilter } from "pixi-filters";

type LyricsSceneProps = {
    artwork: SpriteSource | null;
    className?: string;
};

class PixiLyricsScene {
    app: Application;
    container: Container;
    dimOverlay: Container;

    blurFilters: KawaseBlurFilter[];
    twist: TwistFilter;
    saturation: AdjustmentFilter;
    noise: NoiseFilter;

    paused: boolean;

    constructor(container: HTMLDivElement, imageSource: SpriteSource) {
        this.app = new Application({
            width: container.getBoundingClientRect().width || window.innerWidth,
            height: container.getBoundingClientRect().height || window.innerHeight,
            backgroundAlpha: 0,
            antialias: true,
            powerPreference: "high-performance",
        });
        container.appendChild(this.app.view as HTMLCanvasElement);
        this.paused = false;
        this.container = new Container();
        this.app.stage.addChild(this.container);
        this.addSpritesToContainer(
            Array(4)
                .fill(null)
                .map(() => Sprite.from(imageSource)),
        );

        this.blurFilters = [
            new KawaseBlurFilter(5, 1),
            new KawaseBlurFilter(10, 1),
            new KawaseBlurFilter(20, 2),
            new KawaseBlurFilter(40, 2),
            new KawaseBlurFilter(80, 2),
        ];
        this.twist = new TwistFilter({
            angle: -3.25,
            radius: 900,
            offset: new Point(
                this.app.renderer.screen.width / 2,
                this.app.renderer.screen.height / 2,
            ),
        });
        this.saturation = new AdjustmentFilter({
            saturation: 2.75,
            brightness: 0.7,
            contrast: 1.9,
        });

        this.noise = new NoiseFilter(0.065);
        this.container.filters = [
            this.twist,
            ...this.blurFilters,
            this.saturation,
            this.noise,
        ];

        this.dimOverlay = new Container();
        const blackOverlay = new Graphics();
        blackOverlay.beginFill(0x000000, 0.03);
        blackOverlay.drawRect(
            0,
            0,
            this.app.screen.width,
            this.app.screen.height,
        );
        blackOverlay.endFill();

        const whiteOverlay = new Graphics();
        whiteOverlay.beginFill(0xffffff, 0.03);
        whiteOverlay.drawRect(
            0,
            0,
            this.app.screen.width,
            this.app.screen.height,
        );
        whiteOverlay.endFill();

        this.dimOverlay.addChild(blackOverlay, whiteOverlay);
        this.app.stage.addChild(this.dimOverlay);

        this.app.ticker.add(() => {
            if (this.paused) return;

            const n = this.app.ticker.deltaMS / 33.333333;
            const sprites = this.container.children;

            sprites[0]!.rotation += 0.003 * n;
            sprites[1]!.rotation -= 0.008 * n;

            sprites[2]!.rotation -= 0.006 * n;
            sprites[2]!.x =
                this.app.screen.width / 2 +
                (this.app.screen.width / 4) *
                    Math.cos(sprites[2]!.rotation * 0.75);
            sprites[2]!.y =
                this.app.screen.height / 2 +
                (this.app.screen.width / 4) *
                    Math.sin(sprites[2]!.rotation * 0.75);

            sprites[3]!.rotation += 0.004 * n;
            sprites[3]!.x =
                this.app.screen.width / 2 +
                (this.app.screen.width / 2) * 0.1 +
                (this.app.screen.width / 4) *
                    Math.cos(sprites[3]!.rotation * 0.75);
            sprites[3]!.y =
                this.app.screen.height / 2 +
                (this.app.screen.width / 2) * 0.1 +
                (this.app.screen.width / 4) *
                    Math.sin(sprites[3]!.rotation * 0.75);
        });
    }

    updateArtwork(art: SpriteSource) {
        const sprites = Array(4)
            .fill(null)
            .map(() => Sprite.from(art));

        this.container.children
            .map((child) => child as Sprite)
            .forEach((child, index) => {
                const sprite = sprites[index];
                if (!sprite) {
                    return;
                }

                sprite.rotation = child.rotation;
                sprite.x = child.x;
                sprite.y = child.y;
                sprite.anchor.set(child.anchor.x, child.anchor.y);
                sprite.width = child.width;
                sprite.height = child.height;
            });

        this.container.removeChildren(0);
        this.container.addChild(...sprites);
    }

    addSpritesToContainer(sprites: Sprite[]) {
        const [t, s, i, r] = sprites;

        if (!t || !s || !i || !r) {
            return;
        }

        (t.anchor.set(0.5, 0.5),
            s.anchor.set(0.5, 0.5),
            i.anchor.set(0.5, 0.5),
            r.anchor.set(0.5, 0.5),
            t.position.set(
                this.app.screen.width / 2,
                this.app.screen.height / 2,
            ),
            s.position.set(
                this.app.screen.width / 2.5,
                this.app.screen.height / 2.5,
            ),
            i.position.set(
                this.app.screen.width / 2,
                this.app.screen.height / 2,
            ),
            r.position.set(
                this.app.screen.width / 2,
                this.app.screen.height / 2,
            ),
            (t.width = this.app.screen.width * 1.25),
            (t.height = t.width),
            (s.width = this.app.screen.width * 0.8),
            (s.height = s.width),
            (i.width = this.app.screen.width * 0.5),
            (i.height = i.width),
            (r.width = this.app.screen.width * 0.25),
            (r.height = r.width),
            this.container.addChild(t, s, i, r));
    }

    resize(width: number, height: number) {
        this.app.renderer.resize(width, height);
        this.twist.offset = new Point(width / 2, height / 2);

        const [blackOverlay, whiteOverlay] = this.dimOverlay
            .children as Graphics[];

        if (blackOverlay) {
            blackOverlay.clear();
            blackOverlay.beginFill(0x000000, 0.5);
            blackOverlay.drawRect(0, 0, width, height);
            blackOverlay.endFill();
        }

        if (whiteOverlay) {
            whiteOverlay.clear();
            whiteOverlay.beginFill(0xffffff, 0.05);
            whiteOverlay.drawRect(0, 0, width, height);
            whiteOverlay.endFill();
        }

        const sprites = this.container.children as Sprite[];
        const [t, s, i, r] = sprites;

        if (!t || !s || !i || !r) {
            return;
        }

        t.position.set(width / 2, height / 2);
        s.position.set(width / 2.5, height / 2.5);
        i.position.set(width / 2, height / 2);
        r.position.set(width / 2, height / 2);

        t.width = width * 1.25;
        t.height = t.width;
        s.width = width * 0.8;
        s.height = s.width;
        i.width = width * 0.5;
        i.height = i.width;
        r.width = width * 0.25;
        r.height = r.width;
    }

    destroy() {
        if (this.app) {
            this.app.destroy(true);
        }
    }
}

export default function LyricsScene({ artwork, className }: LyricsSceneProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const sceneRef = useRef<PixiLyricsScene | null>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const scene = new PixiLyricsScene(container, artwork ?? Texture.WHITE);
        sceneRef.current = scene;

        const resize = () => {
            const activeScene = sceneRef.current;
            if (!activeScene) {
                return;
            }
            activeScene.resize(window.innerWidth, window.innerHeight);
        };

        resize();
        window.addEventListener("resize", resize);

        return () => {
            window.removeEventListener("resize", resize);
            scene.destroy();
            sceneRef.current = null;
        };
    }, []);

    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) {
            return;
        }

        scene.updateArtwork(artwork ?? Texture.WHITE);
    }, [artwork]);

    return (
        <div
            ref={containerRef}
            className={className ?? "fixed inset-0 block h-screen w-screen"}
        />
    );
}
