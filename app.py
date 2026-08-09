#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


app = FastAPI(title="TRPG World State Pipeline", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_browser_cache(request, call_next):
    response = await call_next(request)
    if (
        request.url.path == "/"
        or request.url.path.startswith("/static/")
        or request.url.path
        in {
            "/styles.css",
            "/graph.js",
            "/game.js",
            "/world-state-client.js",
            "/app.js",
        }
    ):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


app.mount("/static", StaticFiles(directory="frontend"), name="static")


class PipelineRequest(BaseModel):
    text: str = Field(..., min_length=1)
    max_chars: int = Field(1200, ge=300, le=3000)
    character_names: List[str] = Field(default_factory=list)


class TurnNarrationRequest(BaseModel):
    module_summary: str = Field("", max_length=2000)
    character: Dict[str, Any]
    scene: Dict[str, Any]
    action: Dict[str, Any]
    visible_clues: List[Any] = Field(default_factory=list)
    recent_narration: List[str] = Field(default_factory=list)


@app.get("/")
def index():
    return FileResponse("frontend/index.html")


@app.get("/styles.css")
def frontend_styles():
    return FileResponse("frontend/styles.css", media_type="text/css")


@app.get("/graph.js")
def frontend_graph_script():
    return FileResponse("frontend/graph.js", media_type="text/javascript")


@app.get("/game.js")
def frontend_game_script():
    return FileResponse("frontend/game.js", media_type="text/javascript")


@app.get("/world-state-client.js")
def frontend_world_state_client_script():
    return FileResponse("frontend/world-state-client.js", media_type="text/javascript")


@app.get("/app.js")
def frontend_app_script():
    return FileResponse("frontend/app.js", media_type="text/javascript")


@app.get("/api/health")
def health():
    from utils.character_pipeline import character_pipeline_status

    return {
        "status": "ok",
        "language": "en",
        "character_pipeline": character_pipeline_status(),
    }


@app.post("/api/world-state")
def create_world_state(request: PipelineRequest):
    try:
        from pipeline import run_pipeline_from_text

        return run_pipeline_from_text(
            request.text,
            max_chars=request.max_chars,
            character_names=request.character_names,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/characters")
def create_character_resolution(request: PipelineRequest):
    try:
        from utils.character_pipeline import run_character_pipeline

        return run_character_pipeline(request.text, request.character_names)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/narrate-turn")
def narrate_turn(request: TurnNarrationRequest):
    try:
        from utils.llm_engine import generate_turn_narration

        return generate_turn_narration(request.dict())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
