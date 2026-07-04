import express from 'express';
import workoutRoutes from './routes/workout.routes';
import exerciseRoutes from './routes/exercise.routes';
import migrationRoutes from './routes/migration.routes';
import userRoutes from './routes/user.routes';
import runRoutes from './routes/run.routes';
import recordRoutes from './routes/record.routes';
import weighInRoutes from './routes/weighIn.routes';
import nutritionRoutes from './routes/nutrition.routes';
import foodRoutes from './routes/food.routes';
import { authenticateFirebaseToken } from './middleware/auth';

const app = express();

// The AI endpoints accept base64 photos, so they get a larger body limit.
// Must be registered BEFORE the global express.json() — the first JSON parser
// to run wins, and the global one would reject large payloads first.
app.use(['/api/macros/estimate', '/api/macros/label-scan'], express.json({ limit: '10mb' }));
// Avatar uploads are ~20KB base64 but can exceed the 100KB default limit if a
// client skips resizing; the controller enforces the real cap.
app.use('/api/user/avatar', express.json({ limit: '1mb' }));
app.use(express.json());

// User routes: signup is unprotected, avatar routes carry per-route auth
app.use('/api', userRoutes);

// Protected routes
app.use(authenticateFirebaseToken);
app.use('/api', workoutRoutes);
app.use('/api', exerciseRoutes);
app.use('/api', migrationRoutes);
app.use('/api', runRoutes);
app.use('/api', recordRoutes);
app.use('/api', weighInRoutes);
// foodRoutes must mount BEFORE nutritionRoutes: it owns the literal
// /macros/search-branded-foods and /macros/branded-food/:foodId paths, which
// nutrition's /macros/:date would otherwise swallow (date = "search-branded-foods").
app.use('/api', foodRoutes);
app.use('/api', nutritionRoutes);

export default app;
