import express from 'express';
import workoutRoutes from './routes/workout.routes';

const app = express();
app.use(express.json());
app.use('/api', workoutRoutes);
export default app;
