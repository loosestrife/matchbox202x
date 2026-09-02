async function* nnjsonStream(readableStream, teeOut = false) {
  readableStream.setEncoding("utf-8");
  let leftovers = "";
  for await (const chunk of readableStream){
    if(teeOut){
      console.log(chunk);
    }
    leftovers += chunk;
    const frames = leftovers.split('\n\n');
    leftovers = frames.pop();
    for(const frame of frames){
      yield JSON.parse(frame);
    }
  }
}

module.exports = {nnjsonStream};