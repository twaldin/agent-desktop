import { installUsageTodosFetch } from "./usage-todos-controlled-fetch";
installUsageTodosFetch(process.env.USAGE_TODOS_FIXTURE_DIRECTORY!);
await import("../../omp-workers/entry");
