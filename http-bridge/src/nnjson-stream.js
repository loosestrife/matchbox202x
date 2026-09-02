async function* nnjsonStream(readableStream) {
  readableStream.setEncoding("utf-8");
  let leftovers = "";
  for await (const chunk of readableStream){
    leftovers += chunk;
    const frames = leftovers.split('\n\n');
    leftovers = frames.pop();
    for(const frame of frames){
      yield JSON.parse(frame);
    }
  }
}

async function* teeOutStream(readableStream) {
  readableStream.setEncoding("utf-8");
  let leftovers = "";
  for await (const chunk of readableStream) {
    leftovers += chunk;
    const frames = leftovers.split('\n');
    leftovers = frames.pop();
    for(const frame of frames){
      console.log(frame);
    }
    yield chunk;
  }
}

module.exports = {nnjsonStream, teeOutStream};