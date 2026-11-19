from pydantic import BaseModel, Field


class Message(BaseModel):
    model: str
    role: str
    content: str
    stream: bool = False
    images: list[str] = Field(default_factory=list)
    temperature: float = 0.8

    def construct(self):
        msg = {
            "role": self.role,
            "content": self.content,
        }
        if self.images:
            msg["images"] = self.images

        return {
            "model": self.model,
            "messages": [msg],
            "stream": self.stream,
            "options": {
                "temperature": self.temperature,
            },
        }
