/**
 * MapLibre GL JS Stars Plugin
 *
 * Adds a procedural starry background to globe projection views.
 *
 * Usage:
 *
 * import StarsPlugin from './stars-plugin.js';
 *
 * const map = new maplibregl.Map({
 *   container: 'map',
 *   style: 'your-style.json',
 *   projection: { type: 'globe' }
 * });
 *
 * map.on('load', () => {
 *   const starsPlugin = new StarsPlugin({
 *     intensity: 20.0,  // Brightness of stars (default: 20.0)
 *     density: 0.15     // Percentage of grid cells with stars (default: 0.15 = 15%)
 *   });
 *   map.addControl(starsPlugin);
 * });
 */

class StarsPlugin {
    constructor(options = {}) {
        this.intensity = options.intensity || 20.0;
        this.density = options.density || 0.15;
        this.map = null;
        this.program = null;
        this.vertexBuffer = null;
        this.indexBuffer = null;
        this.vertexShader = null;
        this.fragmentShader = null;
    }

    onAdd(map) {
        this.map = map;
        const gl = map.painter.context.gl;

        // Create shaders
        this.vertexShader = this._createShader(gl, gl.VERTEX_SHADER, `
            attribute vec2 a_pos;
            uniform mat4 u_inv_proj_matrix;
            varying vec3 view_direction;

            void main() {
                view_direction = (u_inv_proj_matrix * vec4(a_pos, 0.0, 1.0)).xyz;
                gl_Position = vec4(a_pos, 1.0, 1.0);
            }
        `);

        this.fragmentShader = this._createShader(gl, gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec3 view_direction;

            uniform vec3 u_globe_position;
            uniform float u_globe_radius;
            uniform float u_stars_intensity;
            uniform vec2 u_globe_center;
            uniform vec3 u_camera_angles;

            const float PI = 3.141592653589793;

            void main() {
                vec3 ray_dir = normalize(view_direction);
                vec3 rotated = ray_dir;

                // Apply camera rotations (pitch, bearing, roll)
                float cosPitch = cos(u_camera_angles.x);
                float sinPitch = sin(u_camera_angles.x);
                rotated = vec3(
                    rotated.x,
                    rotated.y * cosPitch - rotated.z * sinPitch,
                    rotated.y * sinPitch + rotated.z * cosPitch
                );

                float cosBearing = cos(u_camera_angles.y);
                float sinBearing = sin(u_camera_angles.y);
                rotated = vec3(
                    rotated.x * cosBearing - rotated.z * sinBearing,
                    rotated.y,
                    rotated.x * sinBearing + rotated.z * cosBearing
                );

                float cosRoll = cos(u_camera_angles.z);
                float sinRoll = sin(u_camera_angles.z);
                rotated = vec3(
                    rotated.x * cosRoll - rotated.y * sinRoll,
                    rotated.x * sinRoll + rotated.y * cosRoll,
                    rotated.z
                );

                // Apply globe rotation
                float cosLat = cos(u_globe_center.y);
                float sinLat = sin(u_globe_center.y);
                rotated = vec3(
                    rotated.x,
                    rotated.y * cosLat + rotated.z * sinLat,
                    -rotated.y * sinLat + rotated.z * cosLat
                );

                float cosLng = cos(u_globe_center.x);
                float sinLng = sin(u_globe_center.x);
                rotated = vec3(
                    rotated.x * cosLng + rotated.z * sinLng,
                    rotated.y,
                    -rotated.x * sinLng + rotated.z * cosLng
                );

                // Convert to spherical coordinates
                float lng = atan(rotated.x, rotated.z);
                float lat = asin(rotated.y);

                vec2 uv = vec2(
                    (lng / PI) * 0.5 + 0.5,
                    (lat / (PI * 0.5)) * 0.5 + 0.5
                );

                // Create star field
                vec2 scaledUV = uv * 200.0;
                vec2 gridPos = floor(scaledUV);
                float hash = fract(sin(dot(gridPos, vec2(12.9898, 78.233))) * 43758.5453);

                float stars = 0.0;
                if (hash > ${(1 - this.density).toFixed(2)}) {
                    float hashX = fract(sin(dot(gridPos, vec2(127.1, 311.7))) * 43758.5453);
                    float hashY = fract(sin(dot(gridPos, vec2(269.5, 183.3))) * 43758.5453);
                    vec2 randomOffset = vec2(hashX, hashY);
                    vec2 localPos = fract(scaledUV);
                    vec2 delta = (localPos - randomOffset) / 200.0;

                    float aspectCorrection = max(0.3, cos(lat));
                    delta.x /= aspectCorrection;
                    delta.y *= 2.0;

                    float dist = length(delta) * 200.0;
                    float sizeHash = fract(sin(dot(gridPos, vec2(415.2, 371.9))) * 43758.5453);
                    float starSize = 0.015 + 0.025 * sizeHash;

                    stars = 1.0 - smoothstep(0.0, starSize, dist);
                    stars = pow(stars, 4.0);

                    float brightness = 0.5 + 0.5 * sizeHash;
                    stars *= brightness;
                }

                stars *= u_stars_intensity;
                vec3 starColor = vec3(1.0) * stars;

                gl_FragColor = vec4(starColor, 1.0);
            }
        `);

        this.program = this._createProgram(gl, this.vertexShader, this.fragmentShader);

        // Create full-screen quad
        const vertices = new Float32Array([
            -1, -1,
            1, -1,
            1,  1,
            -1,  1
        ]);

        const indices = new Uint16Array([
            0, 1, 2,
            0, 2, 3
        ]);

        this.vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

        this.indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

        // Add the custom layer to integrate properly into rendering pipeline
        const pluginInstance = this;
        this._customLayer = {
            id: 'stars-plugin-layer',
            type: 'custom',
            renderingMode: '3d',

            onAdd: function(map, gl) {
                // Already initialized in plugin
            },

            render: function(gl, matrix) {
                pluginInstance._render(gl);
            }
        };

        // Add as the first layer (background) so everything renders on top
        const layers = this.map.getStyle().layers;
        const firstLayerId = layers && layers.length > 0 ? layers[0].id : undefined;
        this.map.addLayer(this._customLayer, firstLayerId);

        return document.createElement('div');
    }

    _render(gl) {
        if (!this.map || !this.program) return;

        const transform = this.map.transform;

        // Only render in globe projection
        const projectionData = transform.getProjectionData({
            overscaledTileID: null,
            applyGlobeMatrix: true,
            applyTerrainMatrix: true
        });

        if (projectionData.projectionTransition === 0) {
            return; // Not in globe mode
        }

        // Save GL state
        const oldProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const oldDepthFunc = gl.getParameter(gl.DEPTH_FUNC);
        const oldDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const oldBlendEnabled = gl.isEnabled(gl.BLEND);
        const oldBlendSrc = gl.getParameter(gl.BLEND_SRC_ALPHA);
        const oldBlendDst = gl.getParameter(gl.BLEND_DST_ALPHA);

        // Calculate globe position
        const mat4 = this.map.painter.context.mat4 || window.mat4;
        const vec4 = this.map.painter.context.vec4 || window.vec4;

        const vec = new Float64Array(4);
        vec[3] = 1;

        if (mat4 && vec4) {
            vec4.transformMat4(vec, vec, transform.modelViewProjectionMatrix);
            vec[0] /= vec[3];
            vec[1] /= vec[3];
            vec[2] /= vec[3];
            vec[3] = 1;
            vec4.transformMat4(vec, vec, transform.inverseProjectionMatrix);
            vec[0] /= vec[3];
            vec[1] /= vec[3];
            vec[2] /= vec[3];
        }

        const globePosition = [vec[0], vec[1], vec[2]];
        const globeRadius = this._getGlobeRadius(transform.worldSize, transform.center.lat);

        const globeCenter = [
            transform.center.lng * Math.PI / 180.0,
            transform.center.lat * Math.PI / 180.0
        ];

        const cameraAngles = [
            transform.pitchInRadians || (transform.pitch * Math.PI / 180),
            -(transform.bearingInRadians || (transform.bearing * Math.PI / 180)),
            -(transform.rollInRadians || 0)
        ];

        // Use the program
        gl.useProgram(this.program);

        // Set uniforms
        const uInvProjMatrix = gl.getUniformLocation(this.program, 'u_inv_proj_matrix');
        const uGlobePosition = gl.getUniformLocation(this.program, 'u_globe_position');
        const uGlobeRadius = gl.getUniformLocation(this.program, 'u_globe_radius');
        const uStarsIntensity = gl.getUniformLocation(this.program, 'u_stars_intensity');
        const uGlobeCenter = gl.getUniformLocation(this.program, 'u_globe_center');
        const uCameraAngles = gl.getUniformLocation(this.program, 'u_camera_angles');

        gl.uniformMatrix4fv(uInvProjMatrix, false, transform.inverseProjectionMatrix);
        gl.uniform3fv(uGlobePosition, globePosition);
        gl.uniform1f(uGlobeRadius, globeRadius);
        gl.uniform1f(uStarsIntensity, this.intensity);
        gl.uniform2fv(uGlobeCenter, globeCenter);
        gl.uniform3fv(uCameraAngles, cameraAngles);

        // Bind vertex buffer
        const aPosLocation = gl.getAttribLocation(this.program, 'a_pos');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.enableVertexAttribArray(aPosLocation);
        gl.vertexAttribPointer(aPosLocation, 2, gl.FLOAT, false, 0, 0);

        // Draw
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.depthFunc(gl.ALWAYS);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

        // Restore state
        gl.depthFunc(oldDepthFunc);
        gl.depthMask(oldDepthMask);
        if (!oldBlendEnabled) {
            gl.disable(gl.BLEND);
        }
        if (oldBlendSrc && oldBlendDst) {
            gl.blendFunc(oldBlendSrc, oldBlendDst);
        }
        gl.disableVertexAttribArray(aPosLocation);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        if (oldProgram) {
            gl.useProgram(oldProgram);
        }
    }

    _getGlobeRadius(worldSize, latitude) {
        const circumference = worldSize;
        const radius = circumference / (2 * Math.PI);
        return radius * Math.cos(latitude * Math.PI / 180);
    }

    _createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    _createProgram(gl, vertexShader, fragmentShader) {
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Program linking error:', gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return null;
        }

        return program;
    }

    onRemove() {
        if (this.map && this._customLayer) {
            this.map.removeLayer('stars-plugin-layer');
        }

        if (this.program && this.map) {
            const gl = this.map.painter.context.gl;
            gl.deleteProgram(this.program);
            gl.deleteShader(this.vertexShader);
            gl.deleteShader(this.fragmentShader);
            gl.deleteBuffer(this.vertexBuffer);
            gl.deleteBuffer(this.indexBuffer);
        }

        this.map = null;
        this.program = null;
    }

    setIntensity(intensity) {
        this.intensity = intensity;
        if (this.map) {
            this.map.triggerRepaint();
        }
    }

    setDensity(density) {
        this.density = density;
        // Note: Changing density requires recreating the fragment shader
        // This is a simplified version - a full implementation would recreate the shader
        console.warn('Changing density requires recreating the plugin');
    }
}

// Export for use as ES module or global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = StarsPlugin;
}
if (typeof window !== 'undefined') {
    window.StarsPlugin = StarsPlugin;
}
