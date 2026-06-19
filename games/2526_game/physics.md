$ \theta $ : clockwise angle starting from the negative y axis to tne car front direction.

$$\omega = \frac{d\theta}{dt}$$

$x$ : the x position on screen.

$y$ : the y position on screen. Downward as positive.

$v_x$ : the x velocity.

$v_y$ : the y velocity.

Key assumption: 

1. $ \vec{v}=\vec{v_x}+\vec{v_y}$ always has the direction of $\theta - \frac{3\pi}{2}$, ie. $\frac{|\vec{v_y}|}{|\vec{v_x}|} = \tan (\theta-\frac{\pi}{2})$.

Given the width of the car is $W$, the wheel radius of the car is $R$, the angular speed of the left wheel and right wheel are $\omega_1, \omega_2$.

For a given amount of time $dt$:

Forward Distance travelled by left wheel = $R\omega_1  dt$

Forward Distance travelled by right wheel = $R\omega_2  dt$

Assume $\omega_1 > \omega_2$, let the distance between the right wheel to the center of the circular motion be $D$.

We obtain the following system of equation:

$$(D+W)\omega dt = R \omega_1 dt$$
$$D\omega dt = R \omega_2 dt$$

Solving $\omega$:

$$D\omega dt+W \omega dt= R \omega_1 dt$$
$$R \omega_2 dt+W \omega dt= R \omega_1 dt$$
$$W \omega dt= R \omega_1 dt - R \omega_2 dt$$
$$ \omega = \frac{R}{W} (\omega_1  -  \omega_2) $$

Solving $D$, $\omega_1 \ne \omega_2$:

$$D = \frac{R}{\omega} \min(\omega_1, \omega_2)$$

With this very short time $dt$, the displacement $ds$ travelled by the centre of mass of the car is:

$$ ds = (D+\frac{W}{2})\omega dt$$
$$ \frac{ds}{dt} = (D+\frac{W}{2})\omega $$
$$ \vec{v} = (R \frac{\omega_2}{\omega}+\frac{W}{2})\omega $$
$$ \vec{v} = (R \omega_2+\frac{W}{2}\omega) $$
$$ \vec{v} = (R \omega_2+\frac{W}{2}\frac{R}{W} (\omega_1  -  \omega_2)) $$
$$ \vec{v} = \frac{R}{2} (\omega_1  +  \omega_2) $$

By geometry, we will have:

$$\vec{v_y} = |\vec{v}| \sin (\theta - \frac{3\pi}{2})$$

$$\vec{v_x} = |\vec{v}| \cos (\theta - \frac{3\pi}{2})$$


To sum up, the dynamic equations are:

$$\omega = \frac{R}{W}(\omega_1 - \omega_2)$$
$$\vec{v} = \frac{R}{2}(\omega_1 + \omega_2)$$
$$\vec{v_y} = |\vec{v}| \sin (\theta - \frac{3\pi}{2})$$
$$\vec{v_x} = |\vec{v}| \cos (\theta - \frac{3\pi}{2})$$



# Collision Detection and Resolution for 2D Box Collisions

## Overview

This document covers the physics of detecting and resolving collisions between the rectangular car and axis-aligned box obstacles. We assume:
- Car is a rectangle with center at $(x, y)$, width $W$, height $H$, rotated by angle $\theta$
- Obstacles are axis-aligned rectangles (AABBs: Axis-Aligned Bounding Boxes)
- No friction on collision surfaces
- Obstacles are immovable (infinite mass)
- Collisions are elastic (velocities reflect perfectly)

## Step 1: Collision Detection using Separating Axis Theorem (SAT)

For a car (rotated rectangle) and a box obstacle (axis-aligned), we use **Separating Axis Theorem**. Two convex polygons overlap if and only if there is NO axis where they are separated (don't overlap when projected).

### Algorithm

Test three axes:
1. **X-axis** (obstacle's normal)
2. **Y-axis** (obstacle's normal)
3. **Theta-axis** (car's rotation normal, perpendicular to car edges)

### Projecting onto each axis

**X-axis projection:**
- Car corners: project all 4 corners onto X-axis
- Obstacle: get min/max X coordinates
- Check if projections overlap

**Y-axis projection:**
- Car corners: project all 4 corners onto Y-axis
- Obstacle: get min/max Y coordinates
- Check if projections overlap

**Theta-axis projection** (car's local X-axis, direction of $(\cos\theta, \sin\theta)$):
- Car corners: project onto direction $(\cos\theta, \sin\theta)$
- Obstacle corners: project onto direction $(\cos\theta, \sin\theta)$
- Check if projections overlap

**If all three axes show overlap, there is a collision.**

### Code structure:

```python
def check_collision(car, obstacle):
    # Get car corners (rotated rectangle)
    car_corners = get_car_corners(car)
    
    # Project onto X-axis
    car_x_proj = [c[0] for c in car_corners]
    obs_x_proj = [obstacle.x, obstacle.x + obstacle.w]
    if not ranges_overlap(car_x_proj, obs_x_proj):
        return False
    
    # Project onto Y-axis
    car_y_proj = [c[1] for c in car_corners]
    obs_y_proj = [obstacle.y, obstacle.y + obstacle.h]
    if not ranges_overlap(car_y_proj, obs_y_proj):
        return False
    
    # Project onto car's rotation axis
    car_axis = (cos(theta), sin(theta))
    car_rot_proj = [dot(c, car_axis) for c in car_corners]
    obs_corners = obstacle_corners(obstacle)
    obs_rot_proj = [dot(c, car_axis) for c in obs_corners]
    if not ranges_overlap(car_rot_proj, obs_rot_proj):
        return False
    
    return True  # Collision detected
```

## Step 2: Finding Collision Normal and Penetration Depth

Once collision is detected, find:
- **Collision normal**: direction of impulse (perpendicular to contact surface)
- **Penetration depth**: how much the car overlaps the obstacle

For each separating axis that shows overlap, calculate the overlap distance:

$$\text{overlap} = \min(\text{car\_max}, \text{obs\_max}) - \max(\text{car\_min}, \text{obs\_min})$$

The axis with **smallest overlap** is the collision normal direction. This is the "shallowest" penetration.

### Example:
If X-axis overlap is 2 units and Theta-axis overlap is 1 unit, the Theta-axis is the collision normal (smaller penetration).

**Penetration depth** = the smallest overlap value

## Step 3: Collision Response (Impulse Resolution)

Since obstacles are immovable, the car bounces off elastically. The response depends on whether the collision is at the car's center or at a corner.

### Simplified approach: Point-mass approximation

Treat the car center as a point mass. The collision response is:

1. **Find collision normal** $\hat{n}$ (unit vector) from Step 2
2. **Separate the car** by moving it along $-\hat{n}$ by penetration depth:
   $$(x, y) = (x, y) + \text{penetration\_depth} \times (-\hat{n})$$

3. **Reflect velocity** across collision normal:
   $$\vec{v}_{\text{new}} = \vec{v} - 2(\vec{v} \cdot \hat{n})\hat{n}$$
   
   This formula reflects velocity perfectly (elastic collision).

4. **Update angular velocity** if collision affects rotation:
   
   If the collision point is offset from the car center (corner contact), it induces torque:
   $$\tau = \vec{r} \times \vec{F}$$
   
   For a simple approximation, reduce $\omega$ slightly (energy loss to rotation):
   $$\omega_{\text{new}} = \omega \times 0.8 \quad \text{(damping factor)}$$

### Example calculation:

Given:
- Car velocity: $\vec{v} = (2, 3)$
- Collision normal: $\hat{n} = (1, 0)$ (hitting from the right)
- Penetration depth: 1.5 units

**Step 1: Separate**
$$(x, y) = (x, y) + 1.5 \times (-1, 0) = (x - 1.5, y)$$

**Step 2: Reflect velocity**
$$\vec{v} \cdot \hat{n} = 2 \times 1 + 3 \times 0 = 2$$
$$\vec{v}_{\text{new}} = (2, 3) - 2 \times 2 \times (1, 0) = (2 - 4, 3) = (-2, 3)$$

The car bounces backward ($v_x$ reverses) but keeps its lateral velocity ($v_y$).

## Step 4: Angular Velocity Update

For a rigid body collision, the angular velocity changes based on:
- Offset of collision point from center: $\vec{r} = \text{collision\_point} - \text{car\_center}$
- Impulse direction: $\vec{n}$

$$\omega_{\text{new}} = \omega + \frac{\vec{r} \times \vec{J}}{I}$$

Where:
- $\vec{J}$ = impulse = $-m(\vec{v}_{\text{new}} - \vec{v})$ (in 2D, this is a scalar in z-direction)
- $I$ = moment of inertia of car (treat as rectangle)

**Simplified**: For a box car of width $W$ and mass $m$:
$$I = \frac{m(W^2 + H^2)}{12}$$

If collision occurs at a corner 45° from center, the perpendicular offset is $r = \frac{W\sqrt{2}}{4}$.

## Summary: Collision Resolution Algorithm

```python
def resolve_collision(car, obstacle, dt):
    # Step 1: Detect collision
    if not check_collision(car, obstacle):
        return  # No collision
    
    # Step 2: Find normal and penetration
    normal, depth = find_collision_normal_and_depth(car, obstacle)
    
    # Step 3: Separate car
    car.x += -normal[0] * depth
    car.y += -normal[1] * depth
    
    # Step 4: Reflect velocity
    dot_product = car.vx * normal[0] + car.vy * normal[1]
    car.vx -= 2 * dot_product * normal[0]
    car.vy -= 2 * dot_product * normal[1]
    
    # Step 5: Dampen angular velocity
    car.omega *= 0.8
```

## Handling Multiple Simultaneous Collisions

If the car collides with multiple obstacles in one frame:

1. Find **all collisions** in this frame
2. Resolve each collision **sequentially** (in order of penetration depth, deepest first)
3. After each resolution, recheck remaining collisions
4. Repeat until no new collisions are detected

This prevents the car from getting stuck inside obstacles.

## Energy Considerations

- **Before collision**: $E = \frac{1}{2}m(\vec{v} \cdot \vec{v}) + \frac{1}{2}I\omega^2$
- **After elastic collision** (reflecting velocity): Energy is conserved in linear motion
- **In practice**: Add small damping ($\times 0.9$ factor) to prevent infinite bouncing

---

## References

- **Separating Axis Theorem**: Used for convex polygon collision detection
- **Impulse-based resolution**: Standard method in 2D physics engines
- **Elastic collision**: Perfect bounce, no energy loss (in theory)
